import type { Transaction } from "sequelize";
import { ConflictError, EventNotPublishableError, InvalidEventStateError, ValidationAppError } from "../errors/app-errors.js";
import { toEventDto, type EventDto } from "../mappers/event.mapper.js";
import type { EventRow, EventStatus } from "../models/event.js";
import { branchRepository } from "../repositories/branch.repository.js";
import { customerAccountRepository } from "../repositories/customer-account.repository.js";
import { eventRepository } from "../repositories/event.repository.js";
import { fileRepository } from "../repositories/file.repository.js";
import { organizationRepository } from "../repositories/organization.repository.js";
import { ticketTypeRepository } from "../repositories/ticket-type.repository.js";
import { venueRepository } from "../repositories/venue.repository.js";
import { buildPagination } from "../utils/pagination.js";
import { pickDefined } from "../utils/patch.js";
import { firstFreeSlug, SLUG_MAX_LENGTH, slugify } from "../utils/slug.js";
import { isValidTimeZone } from "../utils/time-zone.js";
import type { EventCreateInput, EventListQuery, EventTargetStatus, EventUpdateInput } from "../validators/event.js";
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
] as const;

type Links = Partial<Pick<EventRow, "branch_id" | "customer_account_id" | "venue_id" | "cover_file_id">>;
type Schedule = Pick<EventRow, "starts_at" | "ends_at" | "registration_opens_at" | "registration_closes_at">;

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

async function createEvent(organizationId: string, input: EventCreateInput, actorId: string | null): Promise<EventDto> {
  return runTransaction(async (transaction) => {
    const organization = ensureFound(await organizationRepository.findById(organizationId, { transaction }), "Organization not found");
    await assertLinks(organizationId, input, transaction);
    const schedule: Schedule = {
      starts_at: input.starts_at ?? null,
      ends_at: input.ends_at ?? null,
      registration_opens_at: input.registration_opens_at ?? null,
      registration_closes_at: input.registration_closes_at ?? null,
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
        display_order: 0,
        is_active: true,
        created_by: actorId,
        updated_by: actorId,
      },
      { transaction },
    );
    return toEventDto(event);
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
  const now = new Date();
  return { rows: rows.map((row) => toEventDto(row, now)), count };
}

async function getEvent(organizationId: string, eventId: string): Promise<EventDto> {
  return toEventDto(ensureFound(await eventRepository.findByOrganizationAndId(organizationId, eventId), "Event not found"));
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
    if (patch.capacity !== undefined && patch.capacity !== null) {
      const largestTicketLimit = await ticketTypeRepository.maxCapacityByEvent(organizationId, eventId, { transaction });
      if (largestTicketLimit !== null && largestTicketLimit > patch.capacity) {
        throw new InvalidEventStateError(
          `The event capacity can't be lower than a ticket type's own limit (${largestTicketLimit}). Lower that ticket type first.`,
          { field: "capacity", largest_ticket_type_capacity: largestTicketLimit },
        );
      }
    }
    // A published event must stay publishable (e.g. its dates can't be cleared).
    if (current.status === "PUBLISHED") {
      assertPublishable(merged, await ticketTypeRepository.countActiveByEvent(organizationId, eventId, { transaction }));
    }

    const updated = await eventRepository.updateByOrganizationAndId(
      organizationId,
      eventId,
      { ...patch, updated_by: actorId },
      { transaction },
    );
    return toEventDto(ensureFound(updated, "Event not found"));
  });
}

/** Publish, close or cancel. Asking for the current status again changes nothing. */
async function changeEventStatus(
  organizationId: string,
  eventId: string,
  target: EventTargetStatus,
  actorId: string | null,
): Promise<EventDto> {
  return runTransaction(async (transaction) => {
    // Lock order: the event first, then (through the count) its ticket types, the same order as ticket type changes.
    const current = ensureFound(
      await eventRepository.findByOrganizationAndId(organizationId, eventId, { transaction, lock: true }),
      "Event not found",
    );
    if (current.status === target) return toEventDto(current);
    const from: EventStatus = current.status; // the model's creation-optional brand can't index a record
    if (!ALLOWED_TRANSITIONS[from].includes(target)) {
      throw new InvalidEventStateError(`An event can't go from ${current.status} to ${target}`, { from: current.status, to: target });
    }
    if (target === "PUBLISHED") {
      assertPublishable(current, await ticketTypeRepository.countActiveByEvent(organizationId, eventId, { transaction }));
    }

    const updated = await eventRepository.updateByOrganizationAndId(
      organizationId,
      eventId,
      { status: target, updated_by: actorId },
      { transaction },
    );
    return toEventDto(ensureFound(updated, "Event not found"));
  });
}

export const eventService = { createEvent, listEvents, getEvent, updateEvent, changeEventStatus };
