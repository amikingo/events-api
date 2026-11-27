import { IdempotencyKeyReusedError, InvalidEventStateError, NotFoundError, OutsideAdmissionWindowError, TicketNotAdmissibleError } from "../errors/app-errors.js";
import type { TicketAdmissionRow } from "../models/ticket-admission.js";
import { eventRepository } from "../repositories/event.repository.js";
import { registrationRepository } from "../repositories/registration.repository.js";
import { ticketAdmissionRepository } from "../repositories/ticket-admission.repository.js";
import { ensureFound, runTransaction } from "./helpers.js";

/**
 * Admission at the door (Phase 8 step 2): online, single entry. A gate scans a ticket's QR (whose payload is the
 * ticket's 8-character code, nothing else) or staff type the code; both call `admit`.
 * - Only a CONFIRMED ticket of this organization and event is admitted, once for the whole event. Check-in never
 *   changes the registration, so its place stays taken.
 * - The gate's Idempotency-Key makes retries unambiguous: the same request again (a lost response) returns its
 *   original result; a separate scan of an admitted ticket is ALREADY_CHECKED_IN with the original time.
 * - Atomic: the event row is key-share locked first, then the registration row is locked; one admission per ticket is
 *   a unique key. The event comes first because inserting the admission takes a key-share lock on the event anyway (its
 *   foreign key): taken last, it would wait on a return holding the event while that return waits on this
 *   registration (a deadlock). Key-share locks don't block each other, so gates never wait on one another; a return or
 *   a checkout (event FOR UPDATE) simply goes before or after.
 * - Phase 9: only inside the admission window, from doors_open_at (or starts_at) up to, not including, ends_at
 *   (409 outside_admission_window). One admission per ticket covers the whole event, even a multi-day one.
 * Looking a ticket up or showing its QR never writes anything.
 */

export type CheckInResult = "ADMITTED" | "ALREADY_CHECKED_IN";

export type CheckInDto = {
  result: CheckInResult;
  checked_in_at: Date;
  checked_in_by: string;
  ticket: {
    id: string;
    code: string;
    ticket_type: { code: string; name: string };
    holder: { first_name: string; last_name: string | null } | null;
    order: { reference: string };
  };
};

export type CheckInInput = { organizationId: string; eventId: string; code: string; idempotencyKey: string; actorId: string };

async function describe(organizationId: string, eventId: string, admission: TicketAdmissionRow, result: CheckInResult): Promise<CheckInDto> {
  const ticket = ensureFound(await registrationRepository.findDetailsByEventAndId(organizationId, eventId, admission.registration_id), "Ticket not found");
  return {
    result,
    checked_in_at: admission.admitted_at,
    checked_in_by: admission.admitted_by,
    ticket: {
      id: ticket.id,
      code: ticket.code as string,
      ticket_type: { code: ticket.ticketType.code, name: ticket.ticketType.name },
      holder: ticket.person ? { first_name: ticket.person.first_name, last_name: ticket.person.last_name } : null,
      order: { reference: ticket.order.reference },
    },
  };
}

/** The same key again: its original admission, if the key was used for this ticket at this event. */
async function replay(input: CheckInInput): Promise<CheckInDto | null> {
  const earlier = await ticketAdmissionRepository.findByKey(input.organizationId, input.idempotencyKey);
  if (!earlier) return null;
  const ticket = earlier.event_id === input.eventId ? await registrationRepository.findByEventAndId(input.organizationId, input.eventId, earlier.registration_id) : null;
  if (!ticket || ticket.code !== input.code) throw new IdempotencyKeyReusedError();
  return describe(input.organizationId, input.eventId, earlier, "ADMITTED");
}

async function attempt(input: CheckInInput): Promise<CheckInDto | { raced: true }> {
  const { organizationId, eventId, code, idempotencyKey, actorId } = input;
  const replayed = await replay(input);
  if (replayed) return replayed;

  const outcome = await runTransaction(async (transaction) => {
    const event = ensureFound(await eventRepository.findByOrganizationAndId(organizationId, eventId, { transaction, lock: "keyShare" }), "Event not found");
    if (event.status !== "PUBLISHED") throw new InvalidEventStateError(`Guests of a ${event.status} event can't be checked in`, { status: event.status });
    // Phase 9: the admission window, from the door time (doors_open_at, or starts_at) up to, not including, ends_at.
    // Sales cutoff, sold-out inventory and inactive ticket types don't matter at the door.
    const doorsOpenAt = event.doors_open_at ?? event.starts_at;
    const now = new Date();
    if (doorsOpenAt === null || event.ends_at === null || now < doorsOpenAt || now >= event.ends_at) {
      throw new OutsideAdmissionWindowError(undefined, { doors_open_at: doorsOpenAt, ends_at: event.ends_at });
    }
    const ticket = await registrationRepository.findByEventAndCode(organizationId, eventId, code, { transaction, lock: true });
    if (!ticket) throw new NotFoundError("No ticket with this code at this event");
    if (ticket.status !== "CONFIRMED") throw new TicketNotAdmissibleError(undefined, { status: ticket.status });

    const existing = await ticketAdmissionRepository.findByRegistration(organizationId, ticket.id, { transaction });
    if (existing) return { admission: existing, result: existing.idempotency_key === idempotencyKey ? ("ADMITTED" as const) : ("ALREADY_CHECKED_IN" as const) };
    const admission = await ticketAdmissionRepository.createUnlessTaken(
      { organization_id: organizationId, event_id: eventId, registration_id: ticket.id, admitted_by: actorId, idempotency_key: idempotencyKey },
      { transaction },
    );
    return admission ? { admission, result: "ADMITTED" as const } : null;
  });
  if (outcome === null) return { raced: true };
  return describe(organizationId, eventId, outcome.admission, outcome.result);
}

/**
 * Admits a ticket by its code. 404 for a code that isn't this event's; 409 ticket_not_admissible for a ticket that
 * isn't CONFIRMED; 409 invalid_event_state unless the event is PUBLISHED; 409 idempotency_key_reused when the key
 * already admitted another ticket. A unique-key race (the same key sent with two codes at once) is decided by
 * reading again.
 */
async function admit(input: CheckInInput): Promise<CheckInDto> {
  const first = await attempt(input);
  if (!("raced" in first)) return first;
  const second = await attempt(input);
  if (!("raced" in second)) return second;
  throw new IdempotencyKeyReusedError();
}

export const checkInService = { admit };
