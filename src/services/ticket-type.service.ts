import type { Transaction } from "sequelize";
import { CapacityBelowRegistrationsError, ConflictError, InvalidEventStateError, ValidationAppError } from "../errors/app-errors.js";
import type { EventRow } from "../models/event.js";
import type { TicketTypeRow } from "../models/ticket-type.js";
import { eventRepository } from "../repositories/event.repository.js";
import { registrationRepository } from "../repositories/registration.repository.js";
import { ticketTypeRepository } from "../repositories/ticket-type.repository.js";
import { pickDefined } from "../utils/patch.js";
import type { TicketTypeCreateInput, TicketTypeUpdateInput } from "../validators/ticket-type.js";
import { ensureFound, runTransaction } from "./helpers.js";

/**
 * Ticket types (spec §7): free registration categories of one event. Every change locks the event first and the
 * ticket type second (the spec's lock order for anything that touches capacity). A ticket type's own limit must fit
 * within the event's limit when both are set; limits may add up to more, because all categories share one pool.
 */
const UPDATABLE_FIELDS = ["code", "name", "capacity", "display_order"] as const;

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

async function assertCodeFree(organizationId: string, eventId: string, code: string, transaction: Transaction, ticketTypeId?: string): Promise<void> {
  const holder = await ticketTypeRepository.findByEventAndCode(organizationId, eventId, code, { transaction });
  if (holder && holder.id !== ticketTypeId) throw new ConflictError("Ticket type code must be unique within the event", { field: "code" });
}

async function createTicketType(
  organizationId: string,
  eventId: string,
  input: TicketTypeCreateInput,
  actorId: string | null,
): Promise<TicketTypeRow> {
  return runTransaction(async (transaction) => {
    const event = await lockChangeableEvent(organizationId, eventId, transaction);
    await assertCodeFree(organizationId, eventId, input.code, transaction);
    assertFitsEventCapacity(input.capacity, event);
    const lastOrder = await ticketTypeRepository.maxDisplayOrderByEvent(organizationId, eventId, { transaction });

    return ticketTypeRepository.create(
      {
        organization_id: organizationId,
        event_id: eventId,
        code: input.code,
        name: input.name,
        capacity: input.capacity ?? null,
        display_order: input.display_order ?? (lastOrder === null ? 0 : lastOrder + 1),
        is_active: input.is_active ?? true,
        created_by: actorId,
        updated_by: actorId,
      },
      { transaction },
    );
  });
}

async function listTicketTypes(organizationId: string, eventId: string): Promise<TicketTypeRow[]> {
  ensureFound(await eventRepository.findByOrganizationAndId(organizationId, eventId), "Event not found");
  return ticketTypeRepository.listByEvent(organizationId, eventId);
}

async function updateTicketType(
  organizationId: string,
  eventId: string,
  ticketTypeId: string,
  input: TicketTypeUpdateInput,
  actorId: string | null,
): Promise<TicketTypeRow> {
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
      const confirmed = await registrationRepository.countConfirmedByTicketType(organizationId, eventId, ticketTypeId, { transaction });
      if (confirmed > patch.capacity) {
        throw new CapacityBelowRegistrationsError(
          `This ticket type's limit can't be lower than its confirmed registrations (${confirmed}). Cancel registrations first.`,
          { field: "capacity", confirmed },
        );
      }
    }

    const updated = await ticketTypeRepository.updateByEventAndId(
      organizationId,
      eventId,
      ticketTypeId,
      { ...patch, updated_by: actorId },
      { transaction },
    );
    return ensureFound(updated, "Ticket type not found");
  });
}

/** Activate or deactivate. A published event must keep at least one active ticket type. */
async function changeTicketTypeStatus(
  organizationId: string,
  eventId: string,
  ticketTypeId: string,
  isActive: boolean,
  actorId: string | null,
): Promise<TicketTypeRow> {
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
    return ensureFound(updated, "Ticket type not found");
  });
}

export const ticketTypeService = { createTicketType, listTicketTypes, updateTicketType, changeTicketTypeStatus };
