import type { Transaction } from "sequelize";
import {
  AlreadyRegisteredError,
  CapacityReachedError,
  IdempotencyKeyReusedError,
  InvalidEventStateError,
  NotFoundError,
  PaymentRequiredError,
  PersonInactiveError,
  RegistrationCancelledError,
  RegistrationClosedError,
  TicketNotIssuedError,
  TicketTypeInactiveError,
  TicketTypeRequiredError,
} from "../errors/app-errors.js";
import {
  type ConfirmationDto,
  toMyTicketDto,
  toRegistrationDto,
  toRegistrationSummaryDto,
  type MyTicketDto,
  type RegistrationDto,
  type RegistrationSummaryDto,
} from "../mappers/registration.mapper.js";
import type { EventRow } from "../models/event.js";
import type { PersonRow } from "../models/person.js";
import type { RegistrationRow, RegistrationSource } from "../models/registration.js";
import type { SubmissionScope } from "../models/submission-key.js";
import type { TicketTypeRow } from "../models/ticket-type.js";
import { eventRepository } from "../repositories/event.repository.js";
import { messageOutboxRepository } from "../repositories/message-outbox.repository.js";
import { organizationRepository } from "../repositories/organization.repository.js";
import { personRepository } from "../repositories/person.repository.js";
import { registrationRepository } from "../repositories/registration.repository.js";
import { submissionKeyRepository } from "../repositories/submission-key.repository.js";
import { ticketOrderRepository } from "../repositories/ticket-order.repository.js";
import { ticketTypeRepository } from "../repositories/ticket-type.repository.js";
import { normalizeEthiopianMobile } from "../utils/mobile.js";
import { isZeroAmount } from "../utils/money.js";
import { buildPagination } from "../utils/pagination.js";
import { guestListCsv } from "../utils/guest-csv.js";
import { requestHash } from "../utils/request-hash.js";
import type { PersonInput } from "../validators/person.js";
import type {
  RegistrationCreateInput,
  RegistrationExportQuery,
  RegistrationListQuery,
  RegistrationTargetStatus,
} from "../validators/registration.js";
import { ensureFound, runTransaction } from "./helpers.js";
import { ticketing } from "./ticketing.js";

/**
 * Registrations (spec §8 and the shared rules). One core, `registerInTransaction`, behind staff entry and (4b) the
 * public form. Lock order, the same for every path that changes places: the event, then the ticket type, then the
 * registration. Holding the event lock serializes every registration change of that event, so two guests racing for
 * the last place are decided one after the other. Only CONFIRMED registrations consume places.
 */

/**
 * Who is registering: an existing profile (staff), a new unlinked profile (staff, or the public form without an
 * account), or a signed-in Cheche account (Phase 6). An account registers through its linked profile in the event's
 * organization: found by (organization_id, user_id), or created with the account's verified mobile. An existing
 * linked profile is reused as it is; the form's details only fill a new one.
 */
export type RegistrationGuest =
  | { personId: string }
  | { person: PersonInput }
  | { account: { userId: string; mobile: string; person: Omit<PersonInput, "phone"> } };

export type RegisterInput = {
  organizationId: string;
  eventId: string;
  /** Staff choose by id; the public form (4b) by code. Neither: the event's only active ticket type. */
  ticketTypeId?: string | undefined;
  ticketTypeCode?: string | undefined;
  guest: RegistrationGuest;
  source: RegistrationSource;
  actorId: string | null;
  /** Privacy-notice evidence from the public form; a staff entry has none. */
  evidence?: { privacyNoticeVersion: string; shownAt: Date } | undefined;
};

/** CREATED and REACTIVATED took a place; UNCHANGED found the same confirmed registration (a harmless repeat). */
export type RegisterOutcome = "CREATED" | "REACTIVATED" | "UNCHANGED";
export type RegisterResult = { registration: RegistrationRow; outcome: RegisterOutcome };

/** An Idempotency-Key with the hash of the request it came with (see registerOnce). */
export type SubmissionRequest = { scope: SubmissionScope; key: string; requestHash: string };
/** REPLAYED: the same request was already processed; the original registration is returned as it is now. */
export type SubmissionOutcome = RegisterOutcome | "REPLAYED";


/**
 * The ticket type, locked after the event: by id, by code, or the only active one the caller may use. A STAFF_ONLY
 * type asked for by the public form is "not found", even by its code, so the public can't tell it exists. Since
 * Phase 7 a paid type is refused here (409 payment_required): the single-ticket endpoints only issue free tickets.
 */
async function lockTicketType(
  input: Pick<RegisterInput, "organizationId" | "eventId" | "ticketTypeId" | "ticketTypeCode" | "source">,
  transaction: Transaction,
): Promise<TicketTypeRow> {
  const { organizationId, eventId, source } = input;
  let ticketTypeId = input.ticketTypeId;
  if (ticketTypeId === undefined && input.ticketTypeCode !== undefined) {
    const byCode = await ticketTypeRepository.findByEventAndCode(organizationId, eventId, input.ticketTypeCode, { transaction });
    ticketTypeId = ensureFound(byCode && ticketing.visibleTo(source)(byCode) ? byCode : null, "Ticket type not found").id;
  }
  if (ticketTypeId === undefined) {
    const active = (await ticketTypeRepository.listActiveByEvent(organizationId, eventId, { transaction })).filter(ticketing.visibleTo(source));
    if (active.length === 0) {
      throw new RegistrationClosedError("This event has no ticket types open to the public", { reason: "NO_PUBLIC_TICKETS" });
    }
    const [only, ...others] = active;
    if (!only || others.length > 0) {
      throw new TicketTypeRequiredError("This event has several ticket types: choose one", {
        ticket_types: active.map((ticketType) => ticketType.code),
      });
    }
    ticketTypeId = only.id;
  }

  const ticketType = ensureFound(
    await ticketTypeRepository.findByEventAndId(organizationId, eventId, ticketTypeId, { transaction, lock: true }),
    "Ticket type not found",
  );
  if (!ticketing.visibleTo(source)(ticketType)) throw new NotFoundError("Ticket type not found");
  if (!ticketType.is_active) throw new TicketTypeInactiveError(undefined, { ticket_type_code: ticketType.code });
  if (!isZeroAmount(ticketType.price)) {
    throw new PaymentRequiredError(undefined, { ticket_type_code: ticketType.code, price: ticketType.price, currency: ticketType.currency });
  }
  return ticketType;
}

/** An existing profile of the same organization (active), or a new one. */
async function resolvePerson(input: RegisterInput, transaction: Transaction): Promise<PersonRow> {
  const { organizationId, guest, actorId } = input;
  if ("personId" in guest) {
    const person = ensureFound(await personRepository.findByOrganizationAndId(organizationId, guest.personId, { transaction }), "Guest not found");
    if (!person.is_active) throw new PersonInactiveError();
    return person;
  }
  if ("account" in guest) {
    const { userId, mobile, person: details } = guest.account;
    const person = await personRepository.findOrCreateLinked(
      {
        organization_id: organizationId,
        user_id: userId,
        first_name: details.first_name,
        last_name: details.last_name ?? null,
        email: details.email ?? null,
        phone: mobile,
        affiliation_name: details.affiliation_name ?? null,
        country: details.country ?? null,
        is_active: true,
        created_by: actorId,
        updated_by: actorId,
      },
      { transaction },
    );
    if (!person.is_active) throw new PersonInactiveError();
    return person;
  }
  const values = guest.person;
  return personRepository.create(
    {
      organization_id: organizationId,
      first_name: values.first_name,
      last_name: values.last_name ?? null,
      email: values.email ?? null,
      phone: values.phone ?? null,
      affiliation_name: values.affiliation_name ?? null,
      country: values.country ?? null,
      is_active: true,
      user_id: null,
      created_by: actorId,
      updated_by: actorId,
    },
    { transaction },
  );
}

/** Both limits: the event's capacity and the ticket type's own limit (null means no limit). */
async function assertPlaceAvailable(event: EventRow, ticketType: TicketTypeRow, transaction: Transaction): Promise<void> {
  if (event.capacity !== null) {
    const taken = await registrationRepository.countConfirmedByEvent(event.organization_id, event.id, { transaction });
    if (taken >= event.capacity) throw new CapacityReachedError("This event is full", { scope: "EVENT", capacity: event.capacity });
  }
  await assertTicketTypeHasRoom(event, ticketType, transaction);
}

/** The ticket type's own limit only (null means no limit). Moving a guest between ticket types uses just this. */
async function assertTicketTypeHasRoom(event: EventRow, ticketType: TicketTypeRow, transaction: Transaction): Promise<void> {
  if (ticketType.capacity !== null) {
    const taken = await registrationRepository.countConfirmedByTicketType(event.organization_id, event.id, ticketType.id, { transaction });
    if (taken >= ticketType.capacity) {
      throw new CapacityReachedError("No places are left for this ticket type", {
        scope: "TICKET_TYPE",
        ticket_type_code: ticketType.code,
        capacity: ticketType.capacity,
      });
    }
  }
}

/** The confirmation SMS, queued in the same transaction (spec rule 5); only an Ethiopian mobile can receive it. */
async function queueConfirmation(event: EventRow, person: PersonRow, registration: RegistrationRow, transaction: Transaction): Promise<void> {
  const recipient = person.phone === null ? null : normalizeEthiopianMobile(person.phone);
  if (!recipient) return;
  const organization = ensureFound(await organizationRepository.findById(event.organization_id, { transaction }), "Organization not found");
  await messageOutboxRepository.create(
    {
      organization_id: event.organization_id,
      registration_id: registration.id,
      kind: "REGISTRATION_CONFIRMATION",
      channel: "SMS",
      recipient,
      payload: {
        first_name: person.first_name,
        organization_name: organization.name,
        event_name: event.name,
        starts_at: event.starts_at === null ? null : event.starts_at.toISOString(),
        timezone: event.timezone,
        code: registration.code as string, // a single-ticket registration is always issued with its code
      },
    },
    { transaction },
  );
}

/**
 * The registration core. Locks the event, checks it takes registrations, locks the ticket type, finds or creates
 * the guest, then either returns the same confirmed registration, refuses a second place, or takes a place (new or
 * reactivated) after both capacity checks, and queues the confirmation, all in the caller's transaction.
 */
/** Which request field a missing buyer mobile is reported on (Phase 8: capped events need one for every ticket). */
function mobileField(input: RegisterInput, reactivation: boolean): string {
  if (reactivation) return "registration";
  if ("personId" in input.guest) return "body.person_id";
  return input.source === "PUBLIC" ? "body.phone" : "body.person.phone";
}

async function registerInTransaction(input: RegisterInput, transaction: Transaction): Promise<RegisterResult> {
  const { organizationId, eventId, source, actorId } = input;
  if (source === "STAFF" && actorId === null) throw new Error("A staff registration needs the staff member's id");
  const now = new Date();

  const event = ensureFound(await eventRepository.findByOrganizationAndId(organizationId, eventId, { transaction, lock: true }), "Event not found");
  ticketing.assertTakingRegistrations(event, now);
  await ticketing.releaseExpiredHolds(event, now, transaction);
  const ticketType = await lockTicketType(input, transaction);
  const person = await resolvePerson(input, transaction);

  const existing = await registrationRepository.findByEventAndPerson(organizationId, eventId, person.id, { transaction, lock: true });
  // Phase 7 step 3: a place held (or released) for an unpaid order is never turned into a free ticket here.
  if (existing && (existing.status === "HELD" || existing.status === "RELEASED")) {
    throw new TicketNotIssuedError("This guest has a ticket in an order that isn't paid", { registration_id: existing.id, status: existing.status });
  }
  if (existing?.status === "CONFIRMED") {
    if (existing.ticket_type_id === ticketType.id) return { registration: existing, outcome: "UNCHANGED" };
    throw new AlreadyRegisteredError("This guest is already registered for the event with another ticket type", {
      registration_id: existing.id,
      code: existing.code,
    });
  }

  await assertPlaceAvailable(event, ticketType, transaction);
  // Phase 7: the purchase limit. A new ticket's buyer is the guest (the account's verified mobile when signed in);
  // a reactivated one counts against the buyer of the order it came with.
  const order = existing
    ? ensureFound(await ticketOrderRepository.findByEventAndId(organizationId, eventId, existing.order_id, { transaction }), "Order not found")
    : null;
  const buyerMobile = order ? order.buyer_mobile : person.phone === null ? null : normalizeEthiopianMobile(person.phone);
  await ticketing.assertBuyerAllowance(event, buyerMobile, 1, transaction, mobileField(input, order !== null));

  const registeredBy = source === "STAFF" ? actorId : null;
  let registration: RegistrationRow;
  if (existing) {
    // Reactivation: the same row and code take a place again.
    registration = ensureFound(
      await registrationRepository.updateByEventAndId(
        organizationId,
        eventId,
        existing.id,
        {
          ticket_type_id: ticketType.id,
          status: "CONFIRMED",
          source,
          registered_by: registeredBy,
          registered_at: now,
          cancelled_at: null,
          updated_by: actorId,
        },
        { transaction },
      ),
      "Registration not found",
    );
  } else {
    // Phase 7: every ticket belongs to an order; a single-ticket registration is a one-ticket, free order.
    const newOrder = await ticketOrderRepository.create(
      {
        organization_id: organizationId,
        event_id: eventId,
        reference: await ticketing.newOrderReference(transaction),
        source,
        status: "CONFIRMED",
        buyer_mobile: buyerMobile,
        buyer_user_id: "account" in input.guest ? input.guest.account.userId : null,
        total_amount: "0.00",
        currency: ticketType.currency,
        created_by: actorId,
        updated_by: actorId,
      },
      { transaction },
    );
    registration = await registrationRepository.create(
      {
        organization_id: organizationId,
        event_id: eventId,
        person_id: person.id,
        order_id: newOrder.id,
        price_amount: ticketType.price,
        currency: ticketType.currency,
        ticket_type_id: ticketType.id,
        status: "CONFIRMED",
        source,
        registered_by: registeredBy,
        registered_at: now,
        cancelled_at: null,
        code: await ticketing.newCode(transaction),
        privacy_notice_version: input.evidence?.privacyNoticeVersion ?? null,
        privacy_notice_shown_at: input.evidence?.shownAt ?? null,
        consent_purpose: null,
        consent_version: null,
        consented_at: null,
        created_by: actorId,
        updated_by: actorId,
      },
      { transaction },
    );
  }

  await queueConfirmation(event, person, registration, transaction);
  return { registration, outcome: existing ? "REACTIVATED" : "CREATED" };
}

/**
 * The registration core behind a retry key (spec rule 4). The event is locked first, which serializes retries of the
 * same submission even when they arrive together. The same key with the same request returns the original
 * registration (no new profile, place or message); the same key with another request is refused. Only a successful
 * registration stores its key, so a refused attempt can simply be retried.
 */
async function registerOnce(input: RegisterInput, submission: SubmissionRequest, transaction: Transaction): Promise<{
  registration: RegistrationRow;
  outcome: SubmissionOutcome;
}> {
  const { organizationId, eventId } = input;
  ensureFound(await eventRepository.findByOrganizationAndId(organizationId, eventId, { transaction, lock: true }), "Event not found");

  const earlier = await submissionKeyRepository.findByScopeAndKey(organizationId, submission.scope, submission.key, { transaction });
  if (earlier) {
    if (earlier.request_hash !== submission.requestHash) throw new IdempotencyKeyReusedError();
    // Same hash, so the same event: the original registration, in its current state. (A registration scope's key
    // always names a registration; checkout keys use their own scopes.)
    const registration = ensureFound(
      earlier.registration_id === null ? null : await registrationRepository.findByEventAndId(organizationId, eventId, earlier.registration_id, { transaction }),
      "Registration not found",
    );
    return { registration, outcome: "REPLAYED" };
  }

  const result = await registerInTransaction(input, transaction);
  await submissionKeyRepository.create(
    {
      organization_id: organizationId,
      scope: submission.scope,
      key: submission.key,
      request_hash: submission.requestHash,
      registration_id: result.registration.id,
    },
    { transaction },
  );
  return result;
}

/**
 * The confirmation SMS of each ticket: its own (single-ticket endpoints), or since Phase 7 its order's (checkout
 * sends one SMS per order). Two queries for a whole page.
 */
async function confirmationsOf(
  organizationId: string,
  rows: ReadonlyArray<{ id: string; order_id: string }>,
  options: { transaction: Transaction | null } = { transaction: null },
): Promise<Map<string, NonNullable<ConfirmationDto>>> {
  const own = await messageOutboxRepository.latestByRegistrations(organizationId, rows.map((row) => row.id), options);
  const withoutOwn = rows.filter((row) => !own.has(row.id));
  const byOrder = await messageOutboxRepository.latestByOrders(organizationId, [...new Set(withoutOwn.map((row) => row.order_id))], options);
  const result = new Map<string, NonNullable<ConfirmationDto>>(own);
  for (const row of withoutOwn) {
    const confirmation = byOrder.get(row.order_id);
    if (confirmation) result.set(row.id, confirmation);
  }
  return result;
}

async function toDto(organizationId: string, eventId: string, registrationId: string, transaction?: Transaction): Promise<RegistrationDto> {
  const options = { transaction: transaction ?? null };
  const details = ensureFound(await registrationRepository.findDetailsByEventAndId(organizationId, eventId, registrationId, options), "Registration not found");
  const confirmations = await confirmationsOf(organizationId, [details], options);
  return toRegistrationDto(details, confirmations.get(registrationId) ?? null);
}

/** Staff entry: an existing guest (`person_id`) or a new one (`person`); an optional Idempotency-Key makes it safe to retry. */
async function registerGuest(
  organizationId: string,
  eventId: string,
  input: RegistrationCreateInput,
  actorId: string | null,
  idempotencyKey?: string,
): Promise<{ registration: RegistrationDto; outcome: SubmissionOutcome }> {
  return runTransaction(async (transaction) => {
    const guest: RegistrationGuest = input.person_id !== undefined ? { personId: input.person_id } : { person: input.person as PersonInput };
    const registerInput: RegisterInput = { organizationId, eventId, ticketTypeId: input.ticket_type_id, guest, source: "STAFF", actorId };
    const { registration, outcome } =
      idempotencyKey === undefined
        ? await registerInTransaction(registerInput, transaction)
        : await registerOnce(
            registerInput,
            { scope: "STAFF_REGISTRATION", key: idempotencyKey, requestHash: requestHash({ event_id: eventId, body: input }) },
            transaction,
          );
    return { registration: await toDto(organizationId, eventId, registration.id, transaction), outcome };
  });
}

/**
 * Phase 7: bringing back a cancelled QUICK ticket (no holder profile, so the person-based core can't). The same
 * checks as any new place: the event takes registrations, the ticket type is active, free and open to staff, both
 * capacities have room, and the order's buyer stays within the purchase limit. The same row and code; no SMS (the
 * buyer already has the code). Runs under the event, ticket type and registration locks the caller holds.
 */
async function reactivateUnnamedTicket(event: EventRow, registration: RegistrationRow, actorId: string | null, transaction: Transaction): Promise<void> {
  ticketing.assertTakingRegistrations(event, new Date());
  await ticketing.releaseExpiredHolds(event, new Date(), transaction);
  const ticketType = await lockTicketType(
    { organizationId: event.organization_id, eventId: event.id, ticketTypeId: registration.ticket_type_id, source: "STAFF" },
    transaction,
  );
  await assertPlaceAvailable(event, ticketType, transaction);
  const order = ensureFound(await ticketOrderRepository.findByEventAndId(event.organization_id, event.id, registration.order_id, { transaction }), "Order not found");
  await ticketing.assertBuyerAllowance(event, order.buyer_mobile, 1, transaction, "registration");
  await registrationRepository.updateByEventAndId(
    event.organization_id,
    event.id,
    registration.id,
    { status: "CONFIRMED", registered_at: new Date(), cancelled_at: null, updated_by: actorId },
    { transaction },
  );
}

/**
 * Cancel (frees the place; for PUBLISHED or CLOSED events) or reactivate (every registration check again, through
 * the core). Asking for the current status again changes nothing.
 */
async function changeRegistrationStatus(
  organizationId: string,
  eventId: string,
  registrationId: string,
  target: RegistrationTargetStatus,
  actorId: string | null,
): Promise<RegistrationDto> {
  return runTransaction(async (transaction) => {
    const event = ensureFound(await eventRepository.findByOrganizationAndId(organizationId, eventId, { transaction, lock: true }), "Event not found");
    const current = ensureFound(await registrationRepository.findByEventAndId(organizationId, eventId, registrationId, { transaction }), "Registration not found");
    await ticketTypeRepository.findByEventAndId(organizationId, eventId, current.ticket_type_id, { transaction, lock: true });
    const registration = ensureFound(
      await registrationRepository.findByEventAndId(organizationId, eventId, registrationId, { transaction, lock: true }),
      "Registration not found",
    );
    if (registration.status === "HELD" || registration.status === "RELEASED") {
      throw new TicketNotIssuedError(undefined, { registration_id: registration.id, status: registration.status });
    }
    if (registration.status === target) return toDto(organizationId, eventId, registrationId, transaction);

    if (target === "CONFIRMED" && registration.person_id === null) {
      await reactivateUnnamedTicket(event, registration, actorId, transaction);
      return toDto(organizationId, eventId, registrationId, transaction);
    }
    if (target === "CONFIRMED" && registration.person_id !== null) {
      await registerInTransaction(
        {
          organizationId,
          eventId,
          ticketTypeId: registration.ticket_type_id,
          guest: { personId: registration.person_id },
          source: "STAFF",
          actorId,
        },
        transaction,
      );
      return toDto(organizationId, eventId, registrationId, transaction);
    }

    if (event.status !== "PUBLISHED" && event.status !== "CLOSED") {
      throw new InvalidEventStateError(`Registrations of a ${event.status} event can't be cancelled`, { status: event.status });
    }
    await registrationRepository.updateByEventAndId(
      organizationId,
      eventId,
      registrationId,
      { status: "CANCELLED", cancelled_at: new Date(), updated_by: actorId },
      { transaction },
    );
    return toDto(organizationId, eventId, registrationId, transaction);
  });
}

/**
 * Move a confirmed guest to another ticket type of the same event (Phase 4d, decided 25 November 2026): the same row,
 * code and registered_at; no SMS (the confirmation doesn't name the ticket type). PUBLISHED events only, at any time
 * (also after sign-ups close or the event ended). The new ticket type must be active and have room under its own
 * limit; the event's total doesn't change, so its capacity isn't checked. Since Phase 7 the new type must be free
 * (409 payment_required). Lock order: the event, then both ticket types (by id), then the registration.
 */
async function changeRegistrationTicketType(
  organizationId: string,
  eventId: string,
  registrationId: string,
  ticketTypeId: string,
  actorId: string | null,
): Promise<{ registration: RegistrationDto; changed: boolean }> {
  return runTransaction(async (transaction) => {
    const event = ensureFound(await eventRepository.findByOrganizationAndId(organizationId, eventId, { transaction, lock: true }), "Event not found");
    if (event.status !== "PUBLISHED") {
      throw new InvalidEventStateError(`The ticket type of a guest at a ${event.status} event can't be changed`, { status: event.status });
    }
    const current = ensureFound(await registrationRepository.findByEventAndId(organizationId, eventId, registrationId, { transaction }), "Registration not found");

    const ids = [...new Set([current.ticket_type_id, ticketTypeId])].sort();
    const locked = new Map<string, TicketTypeRow | null>();
    for (const id of ids) {
      locked.set(id, await ticketTypeRepository.findByEventAndId(organizationId, eventId, id, { transaction, lock: true }));
    }
    const target = ensureFound(locked.get(ticketTypeId) ?? null, "Ticket type not found");

    const registration = ensureFound(
      await registrationRepository.findByEventAndId(organizationId, eventId, registrationId, { transaction, lock: true }),
      "Registration not found",
    );
    if (registration.status === "HELD" || registration.status === "RELEASED") {
      throw new TicketNotIssuedError(undefined, { registration_id: registration.id, status: registration.status });
    }
    if (registration.status !== "CONFIRMED") throw new RegistrationCancelledError(undefined, { registration_id: registration.id });
    if (registration.ticket_type_id === target.id) {
      return { registration: await toDto(organizationId, eventId, registrationId, transaction), changed: false };
    }
    if (!target.is_active) throw new TicketTypeInactiveError(undefined, { ticket_type_code: target.code });
    // Phase 7: moving a guest onto a paid type would hand out a paid ticket without payment.
    if (!isZeroAmount(target.price)) {
      throw new PaymentRequiredError("A guest can't be moved to a ticket type with a price", { ticket_type_code: target.code, price: target.price, currency: target.currency });
    }
    await assertTicketTypeHasRoom(event, target, transaction);

    await registrationRepository.updateByEventAndId(
      organizationId,
      eventId,
      registrationId,
      { ticket_type_id: target.id, updated_by: actorId },
      { transaction },
    );
    return { registration: await toDto(organizationId, eventId, registrationId, transaction), changed: true };
  });
}

/** How many registration ids go into one SMS-status query of the export. */
const EXPORT_STATUS_BATCH = 1000;

/**
 * The guest list as a CSV file (Phase 4d): the list's filters and order, every matching guest, dates in the event's
 * time zone. The file is named after the event's slug.
 */
async function exportRegistrations(organizationId: string, eventId: string, query: RegistrationExportQuery): Promise<{ filename: string; csv: string }> {
  const event = ensureFound(await eventRepository.findByOrganizationAndId(organizationId, eventId), "Event not found");
  const rows = await registrationRepository.listAllByEvent(organizationId, eventId, {
    status: query.status,
    ticketTypeId: query.ticket_type_id,
    q: query.q,
    phoneVariant: query.q === undefined ? null : normalizeEthiopianMobile(query.q),
  });
  const confirmations = new Map<string, NonNullable<RegistrationDto["confirmation"]>>();
  for (let start = 0; start < rows.length; start += EXPORT_STATUS_BATCH) {
    const batch = rows.slice(start, start + EXPORT_STATUS_BATCH);
    for (const [id, confirmation] of await confirmationsOf(organizationId, batch)) confirmations.set(id, confirmation);
  }
  const dtos = rows.map((row) => toRegistrationDto(row, confirmations.get(row.id) ?? null));
  return { filename: `${event.slug}-guests.csv`, csv: guestListCsv(dtos, event.timezone) };
}

/** The guest list, newest first; `q` searches the guest's names, email and phone. */
async function listRegistrations(organizationId: string, eventId: string, query: RegistrationListQuery): Promise<{ rows: RegistrationDto[]; count: number }> {
  ensureFound(await eventRepository.findByOrganizationAndId(organizationId, eventId), "Event not found");
  const { limit, offset } = buildPagination(query);
  const { rows, count } = await registrationRepository.listByEvent(organizationId, eventId, {
    status: query.status,
    ticketTypeId: query.ticket_type_id,
    q: query.q,
    phoneVariant: query.q === undefined ? null : normalizeEthiopianMobile(query.q),
    limit,
    offset,
  });
  const confirmations = await confirmationsOf(organizationId, rows);
  return { rows: rows.map((row) => toRegistrationDto(row, confirmations.get(row.id) ?? null)), count };
}

async function getRegistration(organizationId: string, eventId: string, registrationId: string): Promise<RegistrationDto> {
  return toDto(organizationId, eventId, registrationId);
}

/** Places taken and left, for the event and each of its ticket types. */
async function getRegistrationSummary(organizationId: string, eventId: string): Promise<RegistrationSummaryDto> {
  const event = ensureFound(await eventRepository.findByOrganizationAndId(organizationId, eventId), "Event not found");
  const ticketTypes = await ticketTypeRepository.listByEvent(organizationId, eventId);
  const confirmed = await registrationRepository.countConfirmedPerTicketType(organizationId, eventId);
  return toRegistrationSummaryDto(event.capacity, ticketTypes, confirmed);
}

/**
 * My Tickets (Phase 6): a signed-in guest's registrations across organizers. Upcoming and ongoing events first
 * (soonest first), then past ones (most recent first); an event without dates counts as upcoming.
 */
async function listMyTickets(userId: string, now: Date = new Date()): Promise<MyTicketDto[]> {
  const tickets = (await registrationRepository.listByAccount(userId)).map(toMyTicketDto);
  const endOf = (ticket: MyTicketDto) => ticket.event.ends_at ?? ticket.event.starts_at;
  const isPast = (ticket: MyTicketDto) => {
    const end = endOf(ticket);
    return end !== null && end.getTime() <= now.getTime();
  };
  const startTime = (ticket: MyTicketDto) => ticket.event.starts_at?.getTime() ?? Number.POSITIVE_INFINITY;
  const upcoming = tickets.filter((ticket) => !isPast(ticket)).sort((a, b) => startTime(a) - startTime(b));
  const past = tickets.filter(isPast).sort((a, b) => startTime(b) - startTime(a));
  return [...upcoming, ...past];
}

export const registrationService = {
  registerInTransaction,
  registerOnce,
  registerGuest,
  changeRegistrationStatus,
  changeRegistrationTicketType,
  listRegistrations,
  exportRegistrations,
  getRegistration,
  getRegistrationSummary,
  listMyTickets,
};
