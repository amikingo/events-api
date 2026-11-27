import type { Transaction } from "sequelize";
import { CapacityBelowRegistrationsError, ConflictError, InvalidEventStateError, ValidationAppError } from "../errors/app-errors.js";
import type { EventRow } from "../models/event.js";
import type { TicketTypePriceWindowRow } from "../models/ticket-type-price-window.js";
import { toTicketTypeDto, type TicketTypeDto } from "../mappers/ticket-type.mapper.js";
import { eventRepository } from "../repositories/event.repository.js";
import { organizationRepository } from "../repositories/organization.repository.js";
import { registrationRepository } from "../repositories/registration.repository.js";
import { ticketTypePriceWindowRepository } from "../repositories/ticket-type-price-window.repository.js";
import { ticketTypeRepository } from "../repositories/ticket-type.repository.js";
import { pickDefined } from "../utils/patch.js";
import { windowIssues } from "../utils/ticket-pricing.js";
import type { PriceWindowInput, TicketTypeCreateInput, TicketTypeUpdateInput } from "../validators/ticket-type.js";
import { ensureFound, runTransaction } from "./helpers.js";

/**
 * Ticket types (spec §7): registration categories of one event, each with a price ("0.00" is free) and an audience
 * (PUBLIC or STAFF_ONLY) since Phase 7. A price change never touches tickets already issued: an order keeps the
 * prices of its checkout. Every change locks the event first and the
 * ticket type second (the spec's lock order for anything that touches capacity). A ticket type's own limit must fit
 * within the event's limit when both are set; limits may add up to more, because all categories share one pool.
 *
 * Phase 11 (purchase-time pricing): `price` is the regular price and `price_windows` the optional one-off schedule
 * (utils/ticket-pricing). A schedule is replaced as a whole under the same event and ticket-type locks checkout takes,
 * so an order is priced either before or after an edit, never half-way. Orders keep their checkout prices.
 */
const UPDATABLE_FIELDS = ["code", "name", "capacity", "price", "audience", "display_order"] as const;

async function lockChangeableEvent(organizationId: string, eventId: string, transaction: Transaction): Promise<EventRow> {
  const event = ensureFound(await eventRepository.findByOrganizationAndId(organizationId, eventId, { transaction, lock: true }), "Event not found");
  if (event.status === "CLOSED" || event.status === "CANCELLED") {
    throw new InvalidEventStateError(`A ${event.status} event's ticket types can no longer change`, { status: event.status });
  }
  return event;
}

function assertFitsEventCapacity(capacity: number | null | undefined, event: EventRow): void {
  if (capacity !== null && capacity !== undefined && event.capacity !== null && capacity > event.capacity) {
    throw new ValidationAppError("Request validation failed", {
      issues: [
        {
          path: "body.capacity",
          message: `A ticket type's limit must fit within the event's capacity (${event.capacity})`,
          code: "exceeds_event_capacity",
        },
      ],
    });
  }
}

/** Phase 11: a schedule's ranges and overlaps, as 400 issues at body.price_windows.N; nothing is written. */
function assertWindows(windows: readonly PriceWindowInput[]): void {
  const issues = windowIssues(windows);
  if (issues.length > 0) {
    throw new ValidationAppError("Request validation failed", {
      issues: issues.map((issue) => ({ path: `body.price_windows.${issue.index}`, message: issue.message, code: issue.code })),
    });
  }
}

const windowValues = (windows: readonly PriceWindowInput[]) => windows.map((window) => ({ starts_at: window.starts_at, ends_at: window.ends_at ?? null, price: window.price }));

async function windowsOf(organizationId: string, eventId: string, ticketTypeId: string, transaction: Transaction): Promise<TicketTypePriceWindowRow[]> {
  return ticketTypePriceWindowRepository.listByTicketTypes(organizationId, eventId, [ticketTypeId], { transaction });
}

async function assertCodeFree(organizationId: string, eventId: string, code: string, transaction: Transaction, ticketTypeId?: string): Promise<void> {
  const holder = await ticketTypeRepository.findByEventAndCode(organizationId, eventId, code, { transaction });
  if (holder && holder.id !== ticketTypeId) throw new ConflictError("Ticket type code must be unique within the event", { field: "code" });
}

async function createTicketType(
  organizationId: string,
  eventId: string,
  input: TicketTypeCreateInput,
  actorId: string | null,
): Promise<TicketTypeDto> {
  if (input.price_windows !== undefined) assertWindows(input.price_windows);
  return runTransaction(async (transaction) => {
    const event = await lockChangeableEvent(organizationId, eventId, transaction);
    await assertCodeFree(organizationId, eventId, input.code, transaction);
    assertFitsEventCapacity(input.capacity, event);
    const lastOrder = await ticketTypeRepository.maxDisplayOrderByEvent(organizationId, eventId, { transaction });
    const organization = ensureFound(await organizationRepository.findById(organizationId, { transaction }), "Organization not found");

    const created = await ticketTypeRepository.create(
      {
        organization_id: organizationId,
        event_id: eventId,
        code: input.code,
        name: input.name,
        capacity: input.capacity ?? null,
        price: input.price ?? "0.00",
        // The organizer's currency, copied once (Phase 7); later changes there leave this ticket type alone.
        currency: organization.default_currency,
        audience: input.audience ?? "PUBLIC",
        display_order: input.display_order ?? (lastOrder === null ? 0 : lastOrder + 1),
        is_active: input.is_active ?? true,
        created_by: actorId,
        updated_by: actorId,
      },
      { transaction },
    );
    const windows = await ticketTypePriceWindowRepository.replaceForTicketType(organizationId, eventId, created.id, windowValues(input.price_windows ?? []), actorId, { transaction });
    return toTicketTypeDto(created, windows, new Date());
  });
}

async function listTicketTypes(organizationId: string, eventId: string): Promise<TicketTypeDto[]> {
  ensureFound(await eventRepository.findByOrganizationAndId(organizationId, eventId), "Event not found");
  const [ticketTypes, windows] = await Promise.all([
    ticketTypeRepository.listByEvent(organizationId, eventId),
    ticketTypePriceWindowRepository.listByEvent(organizationId, eventId),
  ]);
  const now = new Date();
  return ticketTypes.map((ticketType) => toTicketTypeDto(ticketType, windows.filter((window) => window.ticket_type_id === ticketType.id), now));
}

async function updateTicketType(
  organizationId: string,
  eventId: string,
  ticketTypeId: string,
  input: TicketTypeUpdateInput,
  actorId: string | null,
): Promise<TicketTypeDto> {
  if (input.price_windows !== undefined) assertWindows(input.price_windows);
  return runTransaction(async (transaction) => {
    const event = await lockChangeableEvent(organizationId, eventId, transaction);
    ensureFound(
      await ticketTypeRepository.findByEventAndId(organizationId, eventId, ticketTypeId, { transaction, lock: true }),
      "Ticket type not found",
    );

    const patch = pickDefined(input, UPDATABLE_FIELDS);
    if (patch.code !== undefined) await assertCodeFree(organizationId, eventId, patch.code, transaction, ticketTypeId);
    assertFitsEventCapacity(patch.capacity, event);
    if (patch.capacity !== undefined && patch.capacity !== null) {
      // Phase 9: confirmed tickets (admitted ones once) plus unexpired holds of this type; the event is locked.
      const { confirmed, held } = await registrationRepository.countSecured(organizationId, eventId, new Date(), ticketTypeId, { transaction });
      if (confirmed + held > patch.capacity) {
        throw new CapacityBelowRegistrationsError(
          `This ticket type's limit can't be lower than its confirmed tickets and active holds (${confirmed + held}). Cancel tickets or wait for holds to end first.`,
          { field: "capacity", confirmed, held, minimum: confirmed + held },
        );
      }
    }

    const updated = ensureFound(
      await ticketTypeRepository.updateByEventAndId(organizationId, eventId, ticketTypeId, { ...patch, updated_by: actorId }, { transaction }),
      "Ticket type not found",
    );
    // Phase 11: left out keeps the schedule; a list replaces it as a whole ([] clears it), in this transaction.
    const windows =
      input.price_windows === undefined
        ? await windowsOf(organizationId, eventId, ticketTypeId, transaction)
        : await ticketTypePriceWindowRepository.replaceForTicketType(organizationId, eventId, ticketTypeId, windowValues(input.price_windows), actorId, { transaction });
    return toTicketTypeDto(updated, windows, new Date());
  });
}

/** Activate or deactivate. A published event must keep at least one active ticket type. */
async function changeTicketTypeStatus(
  organizationId: string,
  eventId: string,
  ticketTypeId: string,
  isActive: boolean,
  actorId: string | null,
): Promise<TicketTypeDto> {
  return runTransaction(async (transaction) => {
    const event = await lockChangeableEvent(organizationId, eventId, transaction);
    const ticketType = ensureFound(
      await ticketTypeRepository.findByEventAndId(organizationId, eventId, ticketTypeId, { transaction, lock: true }),
      "Ticket type not found",
    );

    if (!isActive && ticketType.is_active && event.status === "PUBLISHED") {
      const active = await ticketTypeRepository.countActiveByEvent(organizationId, eventId, { transaction });
      if (active <= 1) throw new InvalidEventStateError("A published event must keep at least one active ticket type");
    }

    const updated = await ticketTypeRepository.updateByEventAndId(
      organizationId,
      eventId,
      ticketTypeId,
      { is_active: isActive, updated_by: actorId },
      { transaction },
    );
    return toTicketTypeDto(ensureFound(updated, "Ticket type not found"), await windowsOf(organizationId, eventId, ticketTypeId, transaction), new Date());
  });
}

export const ticketTypeService = { createTicketType, listTicketTypes, updateTicketType, changeTicketTypeStatus };
