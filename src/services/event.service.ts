import type { Transaction } from "sequelize";
import { fileStorageClient } from "../clients/file-storage.client.js";
import {
  CapacityBelowRegistrationsError,
  ConflictError,
  EventNotPublishableError,
  InvalidEventStateError,
  ValidationAppError,
} from "../errors/app-errors.js";
import { toEventDto, type EventDto } from "../mappers/event.mapper.js";
import type { EventRow, EventStatus } from "../models/event.js";
import { branchRepository } from "../repositories/branch.repository.js";
import { customerAccountRepository } from "../repositories/customer-account.repository.js";
import { eventRepository, type EventUpdateValues } from "../repositories/event.repository.js";
import { fileRepository } from "../repositories/file.repository.js";
import { organizationRepository } from "../repositories/organization.repository.js";
import { registrationRepository } from "../repositories/registration.repository.js";
import { ticketTypeRepository } from "../repositories/ticket-type.repository.js";
import { venueRepository } from "../repositories/venue.repository.js";
import { buildPagination } from "../utils/pagination.js";
import { DEFAULT_HOLDER_FIELDS } from "../utils/holder-fields.js";
import { pickDefined } from "../utils/patch.js";
import { firstFreeSlug, SLUG_MAX_LENGTH, slugify } from "../utils/slug.js";
import { isValidTimeZone } from "../utils/time-zone.js";
import type { EventCancelInput, EventCreateInput, EventListQuery, EventRescheduleInput, EventTargetStatus, EventUpdateInput } from "../validators/event.js";
import { eventChangeService } from "./event-change.service.js";
import { ensureFound, runTransaction } from "./helpers.js";

/**
 * Events (spec §5) with the decisions of 25 November 2026:
 * - new events are DRAFT and UNLISTED, copy the organization's timezone, and get General Admission;
 * - DRAFT → PUBLISHED | CANCELLED, PUBLISHED → CLOSED | CANCELLED; CLOSED and CANCELLED are terminal;
 * - the slug is generated when omitted (-2, -3, … on collision) and frozen after the first publication;
 * - stopping sign-ups early means setting registration_closes_at while the event stays PUBLISHED.
 */
const GENERAL_ADMISSION = { code: "GA", name: "General Admission" } as const;
/** Leaves room for a "-NNNN" suffix when a generated slug collides. */
const EVENT_SLUG_BASE_LENGTH = SLUG_MAX_LENGTH - 10;
/** For a name with no Latin letters (e.g. Amharic): event, event-2, …; staff can change it while DRAFT. */
const FALLBACK_SLUG = "event";
const SLUG_FORMAT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const TERMINAL_STATUSES: ReadonlySet<EventStatus> = new Set<EventStatus>(["CLOSED", "CANCELLED"]);
const ALLOWED_TRANSITIONS: Readonly<Record<EventStatus, readonly EventStatus[]>> = {
  DRAFT: ["PUBLISHED", "CANCELLED"],
  PUBLISHED: ["CLOSED", "CANCELLED"],
  CLOSED: [],
  CANCELLED: [],
};

const EDITABLE_FIELDS = [
  "name",
  "slug",
  "description",
  "starts_at",
  "ends_at",
  "doors_open_at",
  "timezone",
  "capacity",
  "registration_opens_at",
  "registration_closes_at",
  "visibility",
  "category",
  "branch_id",
  "customer_account_id",
  "venue_id",
  "cover_file_id",
  "registration_mode",
  "holder_fields",
  "purchase_limit_per_mobile",
] as const;

type Links = Partial<Pick<EventRow, "branch_id" | "customer_account_id" | "venue_id" | "cover_file_id">>;
type Schedule = Pick<EventRow, "starts_at" | "ends_at" | "registration_opens_at" | "registration_closes_at"> & { doors_open_at?: Date | null };

function invalidField(field: string, message: string, code: string): ValidationAppError {
  return new ValidationAppError("Request validation failed", { issues: [{ path: `body.${field}`, message, code }] });
}

/** Each link being set must point at a usable row of this organization; the composite foreign keys are the backstop. */
async function assertLinks(organizationId: string, links: Links, transaction: Transaction): Promise<void> {
  if (links.branch_id) {
    const branch = await branchRepository.findByOrganizationAndId(organizationId, links.branch_id, { transaction });
    if (!branch) throw invalidField("branch_id", "This branch does not belong to the organization", "not_in_organization");
    if (!branch.is_active) throw invalidField("branch_id", "This branch is inactive", "inactive");
  }
  if (links.customer_account_id) {
    const client = await customerAccountRepository.findByOrganizationAndId(organizationId, links.customer_account_id, { transaction });
    if (!client) throw invalidField("customer_account_id", "This client does not belong to the organization", "not_in_organization");
    if (!client.is_active) throw invalidField("customer_account_id", "This client is inactive", "inactive");
  }
  if (links.venue_id) {
    const venue = await venueRepository.findByOrganizationAndId(organizationId, links.venue_id, { transaction });
    if (!venue) throw invalidField("venue_id", "This venue does not belong to the organization", "not_in_organization");
    if (!venue.is_active) throw invalidField("venue_id", "This venue is inactive", "inactive");
  }
  if (links.cover_file_id) {
    const file = await fileRepository.findByOrganizationAndId(organizationId, links.cover_file_id, { transaction });
    if (!file || file.purpose !== "EVENT_COVER") {
      throw invalidField("cover_file_id", "This cover image does not belong to the organization", "not_in_organization");
    }
  }
}

function assertScheduleOrder(schedule: Schedule): void {
  if (schedule.starts_at && schedule.ends_at && schedule.starts_at >= schedule.ends_at) {
    throw invalidField("ends_at", "ends_at must be after starts_at", "invalid_order");
  }
  if (schedule.registration_opens_at && schedule.registration_closes_at && schedule.registration_opens_at >= schedule.registration_closes_at) {
    throw invalidField("registration_closes_at", "registration_closes_at must be after registration_opens_at", "invalid_order");
  }
  if (schedule.doors_open_at && schedule.ends_at && schedule.doors_open_at >= schedule.ends_at) {
    throw invalidField("doors_open_at", "doors_open_at must be before ends_at", "invalid_order");
  }
}

/** Publishing needs a name, a valid slug, a valid timezone, starts_at < ends_at, and an active ticket type. */
function assertPublishable(event: EventRow, activeTicketTypes: number): void {
  const missing: string[] = [];
  if (!event.name.trim()) missing.push("name");
  if (!SLUG_FORMAT.test(event.slug)) missing.push("slug");
  if (!isValidTimeZone(event.timezone)) missing.push("timezone");
  if (!event.starts_at) missing.push("starts_at");
  if (!event.ends_at) missing.push("ends_at");
  if (event.starts_at && event.ends_at && event.starts_at >= event.ends_at) missing.push("ends_at after starts_at");
  if (activeTicketTypes < 1) missing.push("an active ticket type");
  if (missing.length > 0) throw new EventNotPublishableError("The event is not ready to publish", { missing });
}

/**
 * The slug a new or edited event gets. A requested slug must be free (409 otherwise); without one, the name's slug
 * gets the first free suffix. Serialized per organization, with the unique constraint as the backstop.
 */
async function chooseSlug(
  organizationId: string,
  name: string,
  requested: string | undefined,
  transaction: Transaction,
  eventId?: string,
): Promise<string> {
  await eventRepository.lockSlugsOfOrganization(organizationId, { transaction });
  if (requested !== undefined) {
    const holder = await eventRepository.findByOrganizationAndSlug(organizationId, requested, { transaction });
    if (holder && holder.id !== eventId) throw new ConflictError("Another event of this organization already uses this slug", { field: "slug" });
    return requested;
  }
  const generated = slugify(name, EVENT_SLUG_BASE_LENGTH);
  const base = generated.length >= 2 ? generated : FALLBACK_SLUG;
  return firstFreeSlug(base, new Set(await eventRepository.listSlugsWithPrefix(organizationId, base, { transaction })));
}

/** Staff replies carry the cover's URL. One query for a whole page of events. */
async function withCovers(organizationId: string, events: EventRow[], now: Date, transaction?: Transaction): Promise<EventDto[]> {
  const fileIds = [...new Set(events.flatMap((event) => (event.cover_file_id === null ? [] : [event.cover_file_id])))];
  const files = await fileRepository.listByOrganizationAndIds(organizationId, fileIds, { transaction: transaction ?? null });
  const urls = new Map(files.map((file) => [file.id, fileStorageClient.url(file.storage_key)]));
  return events.map((event) => {
    const url = event.cover_file_id === null ? undefined : urls.get(event.cover_file_id);
    return toEventDto(event, now, url === undefined ? null : { url });
  });
}

async function withCover(event: EventRow, transaction?: Transaction): Promise<EventDto> {
  const [dto] = await withCovers(event.organization_id, [event], new Date(), transaction);
  return dto ?? toEventDto(event);
}

async function createEvent(organizationId: string, input: EventCreateInput, actorId: string | null): Promise<EventDto> {
  return runTransaction(async (transaction) => {
    const organization = ensureFound(await organizationRepository.findById(organizationId, { transaction }), "Organization not found");
    await assertLinks(organizationId, input, transaction);
    const schedule: Schedule = {
      starts_at: input.starts_at ?? null,
      ends_at: input.ends_at ?? null,
      registration_opens_at: input.registration_opens_at ?? null,
      registration_closes_at: input.registration_closes_at ?? null,
      doors_open_at: input.doors_open_at ?? null,
    };
    assertScheduleOrder(schedule);
    const slug = await chooseSlug(organizationId, input.name, input.slug, transaction);

    const event = await eventRepository.create(
      {
        organization_id: organizationId,
        name: input.name,
        slug,
        description: input.description ?? null,
        ...schedule,
        // Copied once: later changes to the organization's timezone leave this event alone.
        timezone: input.timezone ?? organization.timezone,
        status: "DRAFT",
        capacity: input.capacity ?? null,
        visibility: input.visibility ?? "UNLISTED",
        category: input.category ?? null,
        branch_id: input.branch_id ?? null,
        customer_account_id: input.customer_account_id ?? null,
        venue_id: input.venue_id ?? null,
        cover_file_id: input.cover_file_id ?? null,
        registration_mode: input.registration_mode ?? "DETAILED",
        holder_fields: input.holder_fields ?? DEFAULT_HOLDER_FIELDS,
        purchase_limit_per_mobile: input.purchase_limit_per_mobile ?? null,
        created_by: actorId,
        updated_by: actorId,
      },
      { transaction },
    );

    // General Admission, in the same transaction: no separate limit, so it draws on the event's limit only.
    await ticketTypeRepository.create(
      {
        organization_id: organizationId,
        event_id: event.id,
        code: GENERAL_ADMISSION.code,
        name: GENERAL_ADMISSION.name,
        capacity: null,
        // Free and public; the organizer's currency, copied once.
        price: "0.00",
        currency: organization.default_currency,
        audience: "PUBLIC",
        display_order: 0,
        is_active: true,
        created_by: actorId,
        updated_by: actorId,
      },
      { transaction },
    );
    return withCover(event, transaction);
  });
}

async function listEvents(organizationId: string, query: EventListQuery): Promise<{ rows: EventDto[]; count: number }> {
  const { limit, offset } = buildPagination(query);
  const { rows, count } = await eventRepository.listByOrganization(organizationId, {
    status: query.status,
    visibility: query.visibility,
    limit,
    offset,
  });
  return { rows: await withCovers(organizationId, rows, new Date()), count };
}

async function getEvent(organizationId: string, eventId: string): Promise<EventDto> {
  return withCover(ensureFound(await eventRepository.findByOrganizationAndId(organizationId, eventId), "Event not found"));
}

async function updateEvent(organizationId: string, eventId: string, input: EventUpdateInput, actorId: string | null): Promise<EventDto> {
  return runTransaction(async (transaction) => {
    const current = ensureFound(
      await eventRepository.findByOrganizationAndId(organizationId, eventId, { transaction, lock: true }),
      "Event not found",
    );
    if (TERMINAL_STATUSES.has(current.status)) {
      throw new InvalidEventStateError(`A ${current.status} event can no longer be edited`, { status: current.status });
    }

    const patch = pickDefined(input, EDITABLE_FIELDS);
    if (patch.slug !== undefined && patch.slug !== current.slug) {
      if (current.status !== "DRAFT") {
        throw new InvalidEventStateError("The slug stays the same after the event is first published, so shared links keep working", {
          field: "slug",
        });
      }
      patch.slug = await chooseSlug(organizationId, current.name, patch.slug, transaction, eventId);
    }
    await assertLinks(organizationId, patch, transaction);

    // pickDefined drops undefined, so every field in `patch` is a real replacement value (null clears).
    const merged = { ...current, ...patch } as EventRow;
    assertScheduleOrder(merged);
    // Phase 9: a previously published event moves only as a whole and only before its first admission (the event is
    // locked FOR UPDATE, so the first gate scan, which key-share locks it, lands before or after this change).
    await eventChangeService.assertReschedulable(current, patch, transaction);
    if (patch.capacity !== undefined && patch.capacity !== null) {
      const largestTicketLimit = await ticketTypeRepository.maxCapacityByEvent(organizationId, eventId, { transaction });
      if (largestTicketLimit !== null && largestTicketLimit > patch.capacity) {
        throw new InvalidEventStateError(
          `The event capacity can't be lower than a ticket type's own limit (${largestTicketLimit}). Lower that ticket type first.`,
          { field: "capacity", largest_ticket_type_capacity: largestTicketLimit },
        );
      }
      // Phase 9: no buyer is displaced. The floor is every confirmed ticket (admitted ones once) plus every unexpired
      // hold; the event is locked, so no order can slip in meanwhile.
      const { confirmed, held } = await registrationRepository.countSecured(organizationId, eventId, new Date(), null, { transaction });
      if (confirmed + held > patch.capacity) {
        throw new CapacityBelowRegistrationsError(
          `The event capacity can't be lower than its confirmed tickets and active holds (${confirmed + held}). Cancel tickets or wait for holds to end first.`,
          { field: "capacity", confirmed, held, minimum: confirmed + held },
        );
      }
    }
    // A published event must stay publishable (e.g. its dates can't be cleared).
    if (current.status === "PUBLISHED") {
      assertPublishable(merged, await ticketTypeRepository.countActiveByEvent(organizationId, eventId, { transaction }));
    }

    const updated = ensureFound(
      await eventRepository.updateByOrganizationAndId(organizationId, eventId, { ...patch, updated_by: actorId }, { transaction }),
      "Event not found",
    );
    // Phase 9: buyers are told about an actual move, in the same transaction (the outbox).
    await eventChangeService.notifyRescheduled(current, updated, transaction);
    return withCover(updated, transaction);
  });
}

/**
 * Phase 9: move the event (the dedicated action). The same rules as a date edit through updateEvent: starts_at and
 * ends_at together, an explicit door time confirmed again (doors_open_at left out keeps an empty one empty), no
 * admission yet for a previously published event; one SMS per order with issued tickets for an actual move.
 */
async function rescheduleEvent(organizationId: string, eventId: string, input: EventRescheduleInput, actorId: string | null): Promise<EventDto> {
  const change: EventUpdateInput = { starts_at: input.starts_at, ends_at: input.ends_at, doors_open_at: input.doors_open_at, description: undefined, category: undefined };
  return updateEvent(organizationId, eventId, change, actorId);
}

/**
 * Phase 9: cancel the whole event (the dedicated action; PATCH …/status CANCELLED goes through it too). See
 * eventChangeService.cancel for what happens to holds, tickets, refunds and SMS.
 */
async function cancelEvent(organizationId: string, eventId: string, input: EventCancelInput, actorId: string | null): Promise<EventDto> {
  const cancelled = await eventChangeService.cancel(organizationId, eventId, { refundAdmittedTickets: input.refund_admitted_tickets }, actorId);
  return withCover(cancelled);
}

/** Publish, close or cancel. Asking for the current status again changes nothing. */
async function changeEventStatus(
  organizationId: string,
  eventId: string,
  target: EventTargetStatus,
  actorId: string | null,
  refundAdmittedTickets?: boolean,
): Promise<EventDto> {
  // Phase 9: cancelling follows one set of rules, whichever route asks for it.
  if (target === "CANCELLED") return cancelEvent(organizationId, eventId, { refund_admitted_tickets: refundAdmittedTickets }, actorId);
  return runTransaction(async (transaction) => {
    // Lock order: the event first, then (through the count) its ticket types, the same order as ticket type changes.
    const current = ensureFound(
      await eventRepository.findByOrganizationAndId(organizationId, eventId, { transaction, lock: true }),
      "Event not found",
    );
    if (current.status === target) return withCover(current, transaction);
    const from: EventStatus = current.status; // the model's creation-optional brand can't index a record
    if (!ALLOWED_TRANSITIONS[from].includes(target)) {
      throw new InvalidEventStateError(`An event can't go from ${current.status} to ${target}`, { from: current.status, to: target });
    }
    if (target === "PUBLISHED") {
      assertPublishable(current, await ticketTypeRepository.countActiveByEvent(organizationId, eventId, { transaction }));
    }

    const values: EventUpdateValues = { status: target, updated_by: actorId };
    // published_at is set once, in the transaction that first publishes the event, and never changed afterwards.
    if (target === "PUBLISHED" && current.published_at === null) values.published_at = new Date();

    const updated = await eventRepository.updateByOrganizationAndId(organizationId, eventId, values, { transaction });
    return withCover(ensureFound(updated, "Event not found"), transaction);
  });
}

export const eventService = { createEvent, listEvents, getEvent, updateEvent, changeEventStatus, cancelEvent, rescheduleEvent };
