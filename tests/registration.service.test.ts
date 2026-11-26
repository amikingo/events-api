import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
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
  TicketTypeInactiveError,
  TicketTypeRequiredError,
} from "../src/errors/app-errors.js";
import type { EventRow } from "../src/models/event.js";
import type { MessageOutboxRow } from "../src/models/message-outbox.js";
import type { PersonRow } from "../src/models/person.js";
import type { RegistrationRow } from "../src/models/registration.js";
import type { TicketTypeRow } from "../src/models/ticket-type.js";
import { eventRepository } from "../src/repositories/event.repository.js";
import { messageOutboxRepository } from "../src/repositories/message-outbox.repository.js";
import { organizationRepository } from "../src/repositories/organization.repository.js";
import { personRepository } from "../src/repositories/person.repository.js";
import { registrationRepository } from "../src/repositories/registration.repository.js";
import { submissionKeyRepository } from "../src/repositories/submission-key.repository.js";
import { ticketTypeRepository } from "../src/repositories/ticket-type.repository.js";
import { transactionManager } from "../src/services/helpers.js";
import { registrationService } from "../src/services/registration.service.js";
import { generateRegistrationCode, REGISTRATION_CODE_PATTERN } from "../src/utils/registration-code.js";
import { requestHash } from "../src/utils/request-hash.js";
import { eventRow, IDS, organizationRow, personRow, registrationRow, ticketTypeRow } from "./helpers/fixtures.js";

/** The registration service against mocked repositories and a fake transaction: no database needed. */
const FAKE_TX = { id: "fake-transaction" } as unknown as Transaction;
const PUBLISHED = { status: "PUBLISHED" as const, published_at: new Date("2026-11-01T00:00:00Z") };
const NEW_GUEST = {
  first_name: "Hana",
  last_name: "Bekele",
  email: undefined,
  phone: "+251911234567",
  affiliation_name: undefined,
  country: undefined,
};

type Arrange = {
  event?: EventRow | null;
  ticketTypes?: TicketTypeRow[];
  person?: PersonRow | null;
  existing?: RegistrationRow | null;
  eventTaken?: number;
  ticketTypeTaken?: number;
};

/** Records every repository call in order, so the lock order can be checked. */
function arrange(options: Arrange = {}) {
  const calls: string[] = [];
  const event = options.event === undefined ? eventRow({ ...PUBLISHED, capacity: 100 }) : options.event;
  const ticketTypes = options.ticketTypes ?? [ticketTypeRow()];
  const person = options.person === undefined ? personRow() : options.person;
  const existing = options.existing ?? null;
  const record = (name: string, repoOptions?: { lock?: boolean }) => calls.push(repoOptions?.lock ? `${name}:lock` : name);

  return {
    calls,
    findEvent: mock.method(eventRepository, "findByOrganizationAndId", async (_o: string, _e: string, repoOptions?: { lock?: boolean }) => {
      record("event", repoOptions);
      return event;
    }),
    listActive: mock.method(ticketTypeRepository, "listActiveByEvent", async () => ticketTypes.filter((ticketType) => ticketType.is_active)),
    findTicketType: mock.method(
      ticketTypeRepository,
      "findByEventAndId",
      async (_o: string, _e: string, id: string, repoOptions?: { lock?: boolean }) => {
        record("ticket_type", repoOptions);
        return ticketTypes.find((ticketType) => ticketType.id === id) ?? null;
      },
    ),
    findPerson: mock.method(personRepository, "findByOrganizationAndId", async () => person),
    createPerson: mock.method(personRepository, "create", async (_values: Partial<PersonRow>, _options?: unknown) => personRow({ id: "new-person" })),
    findExisting: mock.method(
      registrationRepository,
      "findByEventAndPerson",
      async (_o: string, _e: string, _p: string, repoOptions?: { lock?: boolean }) => {
        record("registration", repoOptions);
        return existing;
      },
    ),
    countEvent: mock.method(registrationRepository, "countConfirmedByEvent", async () => options.eventTaken ?? 0),
    countTicketType: mock.method(registrationRepository, "countConfirmedByTicketType", async () => options.ticketTypeTaken ?? 0),
    codeExists: mock.method(registrationRepository, "codeExists", async () => false),
    create: mock.method(registrationRepository, "create", async (values: Partial<RegistrationRow>, _options?: unknown) =>
      registrationRow({ ...values, id: IDS.registration }),
    ),
    update: mock.method(
      registrationRepository,
      "updateByEventAndId",
      async (_o: string, _e: string, _id: string, values: Partial<RegistrationRow>, _options?: unknown) => registrationRow({ ...existing, ...values }),
    ),
    findDetails: mock.method(registrationRepository, "findDetailsByEventAndId", async () => ({
      ...registrationRow(),
      person: personRow(),
      ticketType: ticketTypeRow(),
    })),
    findOrganization: mock.method(organizationRepository, "findById", async () => organizationRow({ name: "Selam Events" })),
    queue: mock.method(messageOutboxRepository, "create", async (_values: Partial<MessageOutboxRow>, _options?: unknown) => ({}) as never),
    latest: mock.method(messageOutboxRepository, "latestByRegistrations", async () => new Map([[IDS.registration, { status: "PENDING" as const, sent_at: null }]])),
  };
}

beforeEach(() => {
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
});
afterEach(() => mock.restoreAll());

function resetTransaction() {
  mock.restoreAll();
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
}

// --- Taking a place -------------------------------------------------------------------------------

test("a new guest is registered CONFIRMED by staff; the event, ticket type and registration are locked in that order", async () => {
  const calls = arrange();

  const { outcome } = await registrationService.registerGuest(IDS.orgA, IDS.event, { person: NEW_GUEST }, IDS.user);

  assert.equal(outcome, "CREATED");
  assert.deepEqual(calls.calls, ["event:lock", "ticket_type:lock", "registration:lock"], "lock order: event, ticket type, registration");
  const [personValues, personOptions] = calls.createPerson.mock.calls[0]?.arguments ?? [];
  assert.deepEqual([personValues?.organization_id, personValues?.first_name, personValues?.phone, personValues?.user_id], [IDS.orgA, "Hana", "+251911234567", null]);
  assert.deepEqual(personOptions, { transaction: FAKE_TX });

  const [values, options] = calls.create.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(
    [values?.status, values?.source, values?.registered_by, values?.person_id, values?.ticket_type_id, values?.cancelled_at],
    ["CONFIRMED", "STAFF", IDS.user, "new-person", IDS.ticketType, null],
  );
  assert.match(String(values?.code), REGISTRATION_CODE_PATTERN);
  assert.deepEqual([values?.privacy_notice_version, values?.consent_purpose], [null, null], "a staff entry records no consent evidence");
  assert.deepEqual(options, { transaction: FAKE_TX });
});

test("the confirmation SMS is queued in the same transaction, for an Ethiopian mobile only", async () => {
  const calls = arrange({ event: eventRow({ ...PUBLISHED, name: "Banking Forum" }) });
  await registrationService.registerGuest(IDS.orgA, IDS.event, { person_id: IDS.person }, IDS.user);

  const [message, options] = calls.queue.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(
    [message?.kind, message?.channel, message?.recipient, message?.registration_id, message?.organization_id],
    ["REGISTRATION_CONFIRMATION", "SMS", "+251911234567", IDS.registration, IDS.orgA],
  );
  assert.deepEqual(message?.payload, {
    first_name: "Hana",
    organization_name: "Selam Events",
    event_name: "Banking Forum",
    starts_at: "2027-03-12T06:00:00.000Z",
    timezone: "Africa/Addis_Ababa",
    code: calls.create.mock.calls[0]?.arguments[0]?.code,
  });
  assert.deepEqual(options, { transaction: FAKE_TX });
  resetTransaction();

  for (const phone of [null, "+44 20 7946 0958"]) {
    const noSms = arrange({ person: personRow({ phone }) });
    await registrationService.registerGuest(IDS.orgA, IDS.event, { person_id: IDS.person }, IDS.user);
    assert.equal(noSms.create.mock.callCount(), 1, "the place is still taken");
    assert.equal(noSms.queue.mock.callCount(), 0, `no SMS for ${String(phone)}`);
    resetTransaction();
  }
});

test("an event that isn't taking registrations is refused with its reason, before anything is written", async () => {
  const past = new Date("2026-01-01T00:00:00Z");
  const future = new Date("2027-01-01T00:00:00Z");
  const cases: Array<[Partial<EventRow>, string]> = [
    [{ status: "DRAFT" }, "NOT_PUBLISHED"],
    [{ status: "CANCELLED" }, "CANCELLED"],
    [{ ...PUBLISHED, status: "CLOSED" }, "CLOSED"],
    [{ ...PUBLISHED, ends_at: past, starts_at: new Date("2025-12-31T00:00:00Z") }, "ENDED"],
    [{ ...PUBLISHED, registration_opens_at: future }, "NOT_OPEN_YET"],
    [{ ...PUBLISHED, registration_closes_at: past }, "CLOSED"],
  ];
  for (const [overrides, reason] of cases) {
    const calls = arrange({ event: eventRow(overrides) });
    await assert.rejects(
      registrationService.registerGuest(IDS.orgA, IDS.event, { person: NEW_GUEST }, IDS.user),
      (error: unknown) => error instanceof RegistrationClosedError && (error.details as { reason: string }).reason === reason,
      reason,
    );
    assert.deepEqual([calls.createPerson.mock.callCount(), calls.create.mock.callCount(), calls.queue.mock.callCount()], [0, 0, 0], reason);
    resetTransaction();
  }
});

test("a full event or a full ticket type is refused; only CONFIRMED registrations are counted", async () => {
  const fullEvent = arrange({ event: eventRow({ ...PUBLISHED, capacity: 100 }), eventTaken: 100 });
  await assert.rejects(
    registrationService.registerGuest(IDS.orgA, IDS.event, { person_id: IDS.person }, IDS.user),
    (error: unknown) => error instanceof CapacityReachedError && (error.details as { scope: string }).scope === "EVENT",
  );
  assert.equal(fullEvent.create.mock.callCount(), 0);
  assert.deepEqual(fullEvent.countEvent.mock.calls[0]?.arguments, [IDS.orgA, IDS.event, { transaction: FAKE_TX }]);
  resetTransaction();

  const fullTicket = arrange({ ticketTypes: [ticketTypeRow({ code: "VIP", capacity: 10 })], ticketTypeTaken: 10 });
  await assert.rejects(
    registrationService.registerGuest(IDS.orgA, IDS.event, { person_id: IDS.person }, IDS.user),
    (error: unknown) =>
      error instanceof CapacityReachedError && JSON.stringify(error.details) === JSON.stringify({ scope: "TICKET_TYPE", ticket_type_code: "VIP", capacity: 10 }),
  );
  assert.equal(fullTicket.create.mock.callCount(), 0);
  resetTransaction();

  const unlimited = arrange({ event: eventRow({ ...PUBLISHED, capacity: null }) });
  await registrationService.registerGuest(IDS.orgA, IDS.event, { person_id: IDS.person }, IDS.user);
  assert.equal(unlimited.countEvent.mock.callCount(), 0, "no limit, no count");
  assert.equal(unlimited.create.mock.callCount(), 1);
});

test("the only active ticket type is used by default; several need a choice; an inactive one is refused", async () => {
  const vip = ticketTypeRow({ id: "vip-id", code: "VIP", name: "VIP" });
  const several = arrange({ ticketTypes: [ticketTypeRow(), vip] });
  await assert.rejects(
    registrationService.registerGuest(IDS.orgA, IDS.event, { person_id: IDS.person }, IDS.user),
    (error: unknown) => error instanceof TicketTypeRequiredError && JSON.stringify(error.details) === JSON.stringify({ ticket_types: ["GA", "VIP"] }),
  );
  assert.equal(several.create.mock.callCount(), 0);

  await registrationService.registerGuest(IDS.orgA, IDS.event, { person_id: IDS.person, ticket_type_id: "vip-id" }, IDS.user);
  assert.equal(several.create.mock.calls[0]?.arguments[0]?.ticket_type_id, "vip-id");
  resetTransaction();

  const inactive = arrange({ ticketTypes: [ticketTypeRow(), ticketTypeRow({ id: "old-id", code: "OLD", is_active: false })] });
  await assert.rejects(
    registrationService.registerGuest(IDS.orgA, IDS.event, { person_id: IDS.person, ticket_type_id: "old-id" }, IDS.user),
    TicketTypeInactiveError,
  );
  await assert.rejects(
    registrationService.registerGuest(IDS.orgA, IDS.event, { person_id: IDS.person, ticket_type_id: "another-events-type" }, IDS.user),
    NotFoundError,
    "a ticket type of another event is not found within this event",
  );
  assert.equal(inactive.create.mock.callCount(), 0);
});

test("an unknown or deactivated guest profile can't be registered", async () => {
  const missing = arrange({ person: null });
  await assert.rejects(registrationService.registerGuest(IDS.orgA, IDS.event, { person_id: IDS.person }, IDS.user), NotFoundError);
  assert.deepEqual(missing.findPerson.mock.calls[0]?.arguments, [IDS.orgA, IDS.person, { transaction: FAKE_TX }], "looked up within the organization");
  resetTransaction();

  const inactive = arrange({ person: personRow({ is_active: false }) });
  await assert.rejects(registrationService.registerGuest(IDS.orgA, IDS.event, { person_id: IDS.person }, IDS.user), PersonInactiveError);
  assert.equal(inactive.create.mock.callCount(), 0);
});

// --- The same guest again -------------------------------------------------------------------------

test("the same guest again: same ticket type is a harmless repeat; another ticket type is refused", async () => {
  const repeat = arrange({ existing: registrationRow() });
  const { outcome } = await registrationService.registerGuest(IDS.orgA, IDS.event, { person_id: IDS.person }, IDS.user);
  assert.equal(outcome, "UNCHANGED");
  assert.deepEqual([repeat.create.mock.callCount(), repeat.update.mock.callCount(), repeat.queue.mock.callCount()], [0, 0, 0], "no second place, no second SMS");
  resetTransaction();

  const other = arrange({ ticketTypes: [ticketTypeRow(), ticketTypeRow({ id: "vip-id", code: "VIP" })], existing: registrationRow() });
  await assert.rejects(
    registrationService.registerGuest(IDS.orgA, IDS.event, { person_id: IDS.person, ticket_type_id: "vip-id" }, IDS.user),
    AlreadyRegisteredError,
  );
  assert.equal(other.update.mock.callCount(), 0);
});

test("a cancelled guest registering again reactivates the same row and code, after the capacity checks", async () => {
  const cancelled = registrationRow({ status: "CANCELLED", cancelled_at: new Date("2026-12-02T00:00:00Z") });
  const full = arrange({ existing: cancelled, eventTaken: 100 });
  await assert.rejects(registrationService.registerGuest(IDS.orgA, IDS.event, { person_id: IDS.person }, IDS.user), CapacityReachedError);
  assert.equal(full.update.mock.callCount(), 0, "a full event refuses the reactivation too");
  resetTransaction();

  const calls = arrange({ existing: cancelled, eventTaken: 99 });
  const before = new Date();
  const { outcome } = await registrationService.registerGuest(IDS.orgA, IDS.event, { person_id: IDS.person }, IDS.user);
  assert.equal(outcome, "REACTIVATED");
  assert.equal(calls.create.mock.callCount(), 0, "the same row, not a new one");
  const [, , id, values, options] = calls.update.mock.calls[0]?.arguments ?? [];
  assert.equal(id, IDS.registration);
  assert.deepEqual([values?.status, values?.cancelled_at, values?.registered_by], ["CONFIRMED", null, IDS.user]);
  assert.ok(values?.registered_at instanceof Date && values.registered_at >= before, "registered_at is renewed");
  assert.ok(!("code" in (values ?? {})), "the code stays the same");
  assert.deepEqual(options, { transaction: FAKE_TX });
  assert.equal(calls.queue.mock.callCount(), 1, "a new confirmation is queued");
});

// --- Cancelling and reactivating through the status endpoint --------------------------------------

function arrangeStatus(registration: RegistrationRow, options: Arrange = {}) {
  const calls = arrange({ existing: registration, ...options });
  mock.method(
    registrationRepository,
    "findByEventAndId",
    async (_o: string, _e: string, _id: string, repoOptions?: { lock?: boolean }) => {
      calls.calls.push(repoOptions?.lock ? "registration:lock" : "registration");
      return registration;
    },
  );
  return calls;
}

test("cancelling frees the place: CANCELLED with cancelled_at, locking the event, ticket type and registration first", async () => {
  const calls = arrangeStatus(registrationRow());
  await registrationService.changeRegistrationStatus(IDS.orgA, IDS.event, IDS.registration, "CANCELLED", IDS.user);

  assert.deepEqual(calls.calls, ["event:lock", "registration", "ticket_type:lock", "registration:lock"]);
  const [, , , values, options] = calls.update.mock.calls[0]?.arguments ?? [];
  assert.equal(values?.status, "CANCELLED");
  assert.ok(values?.cancelled_at instanceof Date);
  assert.deepEqual(options, { transaction: FAKE_TX });
  assert.equal(calls.queue.mock.callCount(), 0, "no SMS on cancel in MVP 1");
});

test("cancelling is for PUBLISHED or CLOSED events; asking for the current status again changes nothing", async () => {
  for (const status of ["DRAFT", "CANCELLED"] as const) {
    const calls = arrangeStatus(registrationRow(), { event: eventRow({ status }) });
    await assert.rejects(registrationService.changeRegistrationStatus(IDS.orgA, IDS.event, IDS.registration, "CANCELLED", IDS.user), InvalidEventStateError);
    assert.equal(calls.update.mock.callCount(), 0, status);
    resetTransaction();
  }

  const closed = arrangeStatus(registrationRow(), { event: eventRow({ ...PUBLISHED, status: "CLOSED" }) });
  await registrationService.changeRegistrationStatus(IDS.orgA, IDS.event, IDS.registration, "CANCELLED", IDS.user);
  assert.equal(closed.update.mock.callCount(), 1, "a CLOSED event's registration can still be cancelled");
  resetTransaction();

  const same = arrangeStatus(registrationRow({ status: "CANCELLED", cancelled_at: new Date() }));
  await registrationService.changeRegistrationStatus(IDS.orgA, IDS.event, IDS.registration, "CANCELLED", IDS.user);
  assert.equal(same.update.mock.callCount(), 0);
});

test("reactivating through the status endpoint repeats every registration check", async () => {
  const cancelled = registrationRow({ status: "CANCELLED", cancelled_at: new Date("2026-12-02T00:00:00Z") });
  const full = arrangeStatus(cancelled, { eventTaken: 100 });
  await assert.rejects(registrationService.changeRegistrationStatus(IDS.orgA, IDS.event, IDS.registration, "CONFIRMED", IDS.user), CapacityReachedError);
  assert.equal(full.update.mock.callCount(), 0);
  resetTransaction();

  const ended = arrangeStatus(cancelled, { event: eventRow({ ...PUBLISHED, status: "CLOSED" }) });
  await assert.rejects(registrationService.changeRegistrationStatus(IDS.orgA, IDS.event, IDS.registration, "CONFIRMED", IDS.user), RegistrationClosedError);
  assert.equal(ended.update.mock.callCount(), 0);
  resetTransaction();

  const ok = arrangeStatus(cancelled);
  await registrationService.changeRegistrationStatus(IDS.orgA, IDS.event, IDS.registration, "CONFIRMED", IDS.user);
  assert.equal(ok.update.mock.calls[0]?.arguments[3]?.status, "CONFIRMED");
  assert.equal(ok.queue.mock.callCount(), 1);
});

// --- Codes ----------------------------------------------------------------------------------------

test("registration codes are 8 characters without look-alikes (no 0, O, 1, I or L)", () => {
  const codes = new Set(Array.from({ length: 2000 }, () => generateRegistrationCode()));
  for (const code of codes) {
    assert.match(code, REGISTRATION_CODE_PATTERN);
    assert.doesNotMatch(code, /[0O1IL]/);
  }
  assert.ok(codes.size > 1990, "random, practically never repeated");
});

// --- Retry keys (Phase 4b) ------------------------------------------------------------------------

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const SUBMISSION = { scope: "PUBLIC_REGISTRATION" as const, key: "key-0000-0001", requestHash: HASH_A };
const PUBLIC_INPUT = {
  organizationId: IDS.orgA,
  eventId: IDS.event,
  guest: { person: NEW_GUEST },
  source: "PUBLIC" as const,
  actorId: null,
  evidence: { privacyNoticeVersion: "2026-11-26", shownAt: new Date("2026-11-26T08:00:00Z") },
};

function arrangeKeys(calls: ReturnType<typeof arrange>, earlier: { request_hash: string; registration_id: string } | null) {
  return {
    findKey: mock.method(submissionKeyRepository, "findByScopeAndKey", async () => {
      calls.calls.push("key");
      return earlier === null ? null : { id: "key-row", organization_id: IDS.orgA, scope: "PUBLIC_REGISTRATION" as const, key: SUBMISSION.key, created_at: new Date(), updated_at: new Date(), ...earlier };
    }),
    storeKey: mock.method(submissionKeyRepository, "create", async (_values: Record<string, unknown>, _options?: unknown) => ({}) as never),
    findOriginal: mock.method(registrationRepository, "findByEventAndId", async () => registrationRow({ source: "PUBLIC", registered_by: null })),
  };
}

test("a new key registers once and stores the key with the request hash in the same transaction; the event is locked before the key is read", async () => {
  const calls = arrange();
  const keys = arrangeKeys(calls, null);

  const { outcome, registration } = await registrationService.registerOnce(PUBLIC_INPUT, SUBMISSION, FAKE_TX);

  assert.equal(outcome, "CREATED");
  assert.deepEqual(calls.calls.slice(0, 2), ["event:lock", "key"], "the event lock serializes retries of the same submission");
  const [values, options] = calls.create.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(
    [values?.source, values?.registered_by, values?.privacy_notice_version, values?.privacy_notice_shown_at],
    ["PUBLIC", null, "2026-11-26", new Date("2026-11-26T08:00:00Z")],
  );
  assert.deepEqual(options, { transaction: FAKE_TX });
  const [stored, storedOptions] = keys.storeKey.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(stored, {
    organization_id: IDS.orgA,
    scope: "PUBLIC_REGISTRATION",
    key: SUBMISSION.key,
    request_hash: HASH_A,
    registration_id: registration.id,
  });
  assert.deepEqual(storedOptions, { transaction: FAKE_TX });
});

test("the same key and request return the original registration: no new profile, place or SMS; another request with that key is refused", async () => {
  const calls = arrange();
  const keys = arrangeKeys(calls, { request_hash: HASH_A, registration_id: IDS.registration });

  const { outcome, registration } = await registrationService.registerOnce(PUBLIC_INPUT, SUBMISSION, FAKE_TX);
  assert.deepEqual([outcome, registration.id], ["REPLAYED", IDS.registration]);
  assert.deepEqual(
    [calls.createPerson.mock.callCount(), calls.create.mock.callCount(), calls.queue.mock.callCount(), keys.storeKey.mock.callCount()],
    [0, 0, 0, 0],
  );
  assert.deepEqual(keys.findOriginal.mock.calls[0]?.arguments, [IDS.orgA, IDS.event, IDS.registration, { transaction: FAKE_TX }]);

  await assert.rejects(registrationService.registerOnce(PUBLIC_INPUT, { ...SUBMISSION, requestHash: HASH_B }, FAKE_TX), IdempotencyKeyReusedError);
  assert.equal(calls.create.mock.callCount(), 0);
});

test("a refused attempt stores no key, so the same submission can be retried later", async () => {
  const calls = arrange({ eventTaken: 100 });
  const keys = arrangeKeys(calls, null);
  await assert.rejects(registrationService.registerOnce(PUBLIC_INPUT, SUBMISSION, FAKE_TX), CapacityReachedError);
  assert.equal(keys.storeKey.mock.callCount(), 0);
});

test("staff may send a key too: it is scoped to staff entry and hashes the event with the request body", async () => {
  const calls = arrange();
  const keys = arrangeKeys(calls, null);
  const body = { person: NEW_GUEST, ticket_type_id: undefined, person_id: undefined };

  const { outcome } = await registrationService.registerGuest(IDS.orgA, IDS.event, body, IDS.user, "staff-key-0001");

  assert.equal(outcome, "CREATED");
  const [stored] = keys.storeKey.mock.calls[0]?.arguments ?? [];
  assert.deepEqual([stored?.scope, stored?.key, stored?.request_hash], ["STAFF_REGISTRATION", "staff-key-0001", requestHash({ event_id: IDS.event, body })]);
});

test("the request hash ignores field order and unsent fields, and changes with any value", () => {
  const base = requestHash({ event_id: IDS.event, body: { first_name: "Liya", phone: "+251912000001", email: undefined } });
  assert.equal(base, requestHash({ body: { phone: "+251912000001", first_name: "Liya" }, event_id: IDS.event }));
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.notEqual(base, requestHash({ event_id: IDS.event, body: { first_name: "Liyu", phone: "+251912000001" } }));
  assert.notEqual(base, requestHash({ event_id: "another-event", body: { first_name: "Liya", phone: "+251912000001" } }));
});

test("staff replies show the latest confirmation SMS of the registration", async () => {
  const calls = arrange();
  const { registration } = await registrationService.registerGuest(IDS.orgA, IDS.event, { person_id: IDS.person }, IDS.user);
  assert.deepEqual(registration.confirmation, { status: "PENDING", sent_at: null });
  assert.deepEqual(calls.latest.mock.calls[0]?.arguments, [IDS.orgA, [IDS.registration], { transaction: FAKE_TX }], "read inside the transaction that queued it");
});

// --- Changing a ticket type (Phase 4d) -----------------------------------------------------------

/** Sorts before IDS.ticketType, so a fixed lock order shows up as VIP first. */
const VIP_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb0";
const vip = (overrides: Partial<TicketTypeRow> = {}) => ticketTypeRow({ id: VIP_ID, code: "VIP", name: "VIP", capacity: 10, ...overrides });

function arrangeMove(options: Arrange & { registration?: RegistrationRow; vipRow?: TicketTypeRow | null } = {}) {
  const vipRow = options.vipRow === undefined ? vip() : options.vipRow;
  const calls = arrange({ ...options, ticketTypes: options.ticketTypes ?? [ticketTypeRow(), ...(vipRow ? [vipRow] : [])] });
  const registration = options.registration ?? registrationRow();
  const findRegistration = mock.method(
    registrationRepository,
    "findByEventAndId",
    async (_o: string, _e: string, _id: string, repoOptions?: { lock?: boolean }) => {
      calls.calls.push(repoOptions?.lock ? "registration:lock" : "registration");
      return registration;
    },
  );
  return { ...calls, findRegistration };
}

test("moving a guest keeps the row and its code, writes only the ticket type, queues no SMS, and locks event, both ticket types (by id), then the registration", async () => {
  const calls = arrangeMove({ event: eventRow({ ...PUBLISHED, capacity: 1 }), eventTaken: 1 });

  const { registration, changed } = await registrationService.changeRegistrationTicketType(IDS.orgA, IDS.event, IDS.registration, VIP_ID, IDS.user);

  assert.equal(changed, true);
  assert.equal(registration.code, "K7M2Q9XP");
  assert.deepEqual(calls.calls, ["event:lock", "registration", "ticket_type:lock", "ticket_type:lock", "registration:lock"]);
  assert.deepEqual(
    calls.findTicketType.mock.calls.map((call) => call.arguments[2]),
    [VIP_ID, IDS.ticketType],
    "ticket types locked in id order",
  );
  const [org, event, id, values, options] = calls.update.mock.calls[0]?.arguments ?? [];
  assert.deepEqual([org, event, id, values, options], [IDS.orgA, IDS.event, IDS.registration, { ticket_type_id: VIP_ID, updated_by: IDS.user }, { transaction: FAKE_TX }]);
  assert.equal(calls.queue.mock.callCount(), 0, "no SMS");
  assert.equal(calls.countEvent.mock.callCount(), 0, "a full event doesn't matter: its total doesn't change");
  assert.deepEqual(calls.countTicketType.mock.calls[0]?.arguments.slice(0, 3), [IDS.orgA, IDS.event, VIP_ID]);
});

test("the ticket type the guest already has changes nothing", async () => {
  const calls = arrangeMove();
  const { changed } = await registrationService.changeRegistrationTicketType(IDS.orgA, IDS.event, IDS.registration, IDS.ticketType, IDS.user);
  assert.equal(changed, false);
  assert.equal(calls.update.mock.callCount(), 0);
  assert.equal(calls.findTicketType.mock.callCount(), 1, "one ticket type, locked once");
});

test("a move is refused for a cancelled guest, an inactive, full or unknown ticket type, and any event that isn't PUBLISHED", async () => {
  const cases: Array<[string, Parameters<typeof arrangeMove>[0], (error: unknown) => boolean]> = [
    ["cancelled guest", { registration: registrationRow({ status: "CANCELLED", cancelled_at: new Date() }) }, (e) => e instanceof RegistrationCancelledError],
    ["inactive ticket type", { vipRow: vip({ is_active: false }) }, (e) => e instanceof TicketTypeInactiveError],
    [
      "full ticket type",
      { vipRow: vip({ capacity: 10 }), ticketTypeTaken: 10 },
      (e) => e instanceof CapacityReachedError && (e.details as { scope: string }).scope === "TICKET_TYPE",
    ],
    ["ticket type of another event", { vipRow: null }, (e) => e instanceof NotFoundError],
    ...(["DRAFT", "CLOSED", "CANCELLED"] as const).map(
      (status): [string, Parameters<typeof arrangeMove>[0], (error: unknown) => boolean] => [
        `${status} event`,
        { event: eventRow({ ...PUBLISHED, status }) },
        (e) => e instanceof InvalidEventStateError && (e.details as { status: string }).status === status,
      ],
    ),
  ];
  for (const [label, options, check] of cases) {
    const calls = arrangeMove(options);
    await assert.rejects(registrationService.changeRegistrationTicketType(IDS.orgA, IDS.event, IDS.registration, VIP_ID, IDS.user), check, label);
    assert.equal(calls.update.mock.callCount(), 0, label);
    resetTransaction();
  }
});

test("a PUBLISHED event that has ended or closed sign-ups still allows a move (at the door)", async () => {
  const ended = { starts_at: new Date("2026-01-01T06:00:00Z"), ends_at: new Date("2026-01-01T14:00:00Z"), registration_closes_at: new Date("2025-12-31T00:00:00Z") };
  const calls = arrangeMove({ event: eventRow({ ...PUBLISHED, ...ended }) });
  const { changed } = await registrationService.changeRegistrationTicketType(IDS.orgA, IDS.event, IDS.registration, VIP_ID, IDS.user);
  assert.equal(changed, true);
  assert.equal(calls.update.mock.callCount(), 1);
});

// --- Export (Phase 4d) ----------------------------------------------------------------------------

test("the export uses the list's filters without paging, names the file after the event slug, and reads SMS statuses 1,000 ids at a time", async () => {
  arrange({ event: eventRow({ slug: "banking-forum", timezone: "Africa/Addis_Ababa" }) });
  const rows = Array.from({ length: 2001 }, (_unused, index) => ({
    ...registrationRow({ id: `reg-${index}`, code: `CODE${index}` }),
    person: personRow(),
    ticketType: ticketTypeRow(),
  }));
  const listAll = mock.method(registrationRepository, "listAllByEvent", async () => rows);
  const latest = mock.method(messageOutboxRepository, "latestByRegistrations", async (_o: string, ids: string[]) => new Map(ids.map((id) => [id, { status: "SENT" as const, sent_at: null }])));

  const { filename, csv } = await registrationService.exportRegistrations(IDS.orgA, IDS.event, { status: "CONFIRMED", ticket_type_id: IDS.ticketType, q: "0911234567" });

  assert.equal(filename, "banking-forum-guests.csv");
  assert.deepEqual(listAll.mock.calls[0]?.arguments, [
    IDS.orgA,
    IDS.event,
    { status: "CONFIRMED", ticketTypeId: IDS.ticketType, q: "0911234567", phoneVariant: "+251911234567" },
  ]);
  assert.deepEqual(latest.mock.calls.map((call) => call.arguments[1].length), [1000, 1000, 1]);
  const lines = csv.trimEnd().split("\r\n");
  assert.equal(lines.length, 2002, "header plus every guest");
  assert.match(lines[1] ?? "", /^CODE0,Confirmed,Hana,/);
});

// --- Signed-in guests (Phase 6) -------------------------------------------------------------------

const GUEST_ID = "d1111111-1111-4111-8111-111111111111";
const ACCOUNT_GUEST = { account: { userId: GUEST_ID, mobile: "+251911223344", person: { first_name: "Hana", last_name: "Bekele", email: undefined, affiliation_name: undefined, country: undefined } } };

test("a signed-in guest registers through the account's linked profile, created with the account's mobile and user id", async () => {
  const calls = arrange();
  const linked = mock.method(personRepository, "findOrCreateLinked", async (_values: Partial<PersonRow>, _options?: unknown) =>
    personRow({ id: "linked-person", user_id: GUEST_ID, phone: "+251911223344" }),
  );

  const { outcome } = await registrationService.registerInTransaction(
    { organizationId: IDS.orgA, eventId: IDS.event, guest: ACCOUNT_GUEST, source: "PUBLIC", actorId: null },
    FAKE_TX,
  );

  assert.equal(outcome, "CREATED");
  const [values, options] = linked.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(
    [values?.organization_id, values?.user_id, values?.phone, values?.first_name, values?.last_name],
    [IDS.orgA, GUEST_ID, "+251911223344", "Hana", "Bekele"],
  );
  assert.deepEqual(options, { transaction: FAKE_TX });
  assert.equal(calls.createPerson.mock.callCount(), 0, "never an unlinked profile");
  assert.equal(calls.create.mock.calls[0]?.arguments[0]?.person_id, "linked-person");
});

test("a deactivated linked profile can't register", async () => {
  arrange();
  mock.method(personRepository, "findOrCreateLinked", async () => personRow({ user_id: GUEST_ID, is_active: false }));
  await assert.rejects(
    registrationService.registerInTransaction({ organizationId: IDS.orgA, eventId: IDS.event, guest: ACCOUNT_GUEST, source: "PUBLIC", actorId: null }, FAKE_TX),
    PersonInactiveError,
  );
});

// --- My Tickets (Phase 6) -------------------------------------------------------------------------

test("My Tickets: upcoming first (soonest first), then past (most recent first), with only the guest-facing fields", async () => {
  const now = new Date("2027-01-01T00:00:00Z");
  const row = (code: string, starts: string, ends: string) => ({
    ...registrationRow({ code }),
    event: { ...eventRow({ starts_at: new Date(starts), ends_at: new Date(ends) }), organization: { name: "Selam Events", slug: "selam-events" } },
    ticketType: ticketTypeRow(),
  });
  const list = mock.method(registrationRepository, "listByAccount", async (_userId: string) => [
    row("PASTOLD1", "2026-03-01T06:00:00Z", "2026-03-01T10:00:00Z"),
    row("LATER001", "2027-06-01T06:00:00Z", "2027-06-01T10:00:00Z"),
    row("PASTNEW1", "2026-12-01T06:00:00Z", "2026-12-01T10:00:00Z"),
    row("SOON0001", "2027-02-01T06:00:00Z", "2027-02-01T10:00:00Z"),
  ]);

  const tickets = await registrationService.listMyTickets(GUEST_ID, now);

  assert.deepEqual(list.mock.calls[0]?.arguments, [GUEST_ID]);
  assert.deepEqual(tickets.map((ticket) => ticket.code), ["SOON0001", "LATER001", "PASTNEW1", "PASTOLD1"]);
  assert.deepEqual(Object.keys(tickets[0] ?? {}).sort(), ["cancelled_at", "code", "event", "organization", "registered_at", "status", "ticket_type"]);
  assert.deepEqual(tickets[0]?.organization, { name: "Selam Events", slug: "selam-events" });
  assert.deepEqual(Object.keys(tickets[0]?.event ?? {}).sort(), ["ends_at", "name", "slug", "starts_at", "status", "timezone"]);
});

// --- Phase 7 step 1: audiences and prices on the single-ticket endpoints -----------------------------------

// PUBLIC_INPUT (above): a public-form registration of a new guest.

test("the public form never sees a staff-only type: not found by code, not counted as the only type, closed when it's the only one", async () => {
  const crew = ticketTypeRow({ id: "crew-id", code: "CREW", audience: "STAFF_ONLY" });
  const calls = arrange({ ticketTypes: [ticketTypeRow(), crew] });
  mock.method(ticketTypeRepository, "findByEventAndCode", async (_o: string, _e: string, code: string) => (code === "CREW" ? crew : null));

  await assert.rejects(registrationService.registerInTransaction({ ...PUBLIC_INPUT, ticketTypeCode: "CREW" }, FAKE_TX), NotFoundError);
  const { registration } = await registrationService.registerInTransaction(PUBLIC_INPUT, FAKE_TX);
  assert.equal(registration.ticket_type_id, IDS.ticketType, "GA is the only public type, so it's the default");
  resetTransaction();

  const onlyCrew = arrange({ ticketTypes: [crew] });
  await assert.rejects(
    registrationService.registerInTransaction(PUBLIC_INPUT, FAKE_TX),
    (error: unknown) => error instanceof RegistrationClosedError && (error.details as { reason: string }).reason === "NO_PUBLIC_TICKETS",
  );
  assert.equal(onlyCrew.create.mock.callCount(), 0);
  assert.equal(calls.create.mock.callCount(), 1);
});

test("staff may issue a staff-only type", async () => {
  const crew = ticketTypeRow({ id: "crew-id", code: "CREW", audience: "STAFF_ONLY" });
  const calls = arrange({ ticketTypes: [crew] });
  await registrationService.registerGuest(IDS.orgA, IDS.event, { person_id: IDS.person, ticket_type_id: "crew-id" }, IDS.user);
  assert.equal(calls.create.mock.calls[0]?.arguments[0]?.ticket_type_id, "crew-id");
});

test("a paid type is refused on the single-ticket endpoints (payment_required), for staff and the public alike", async () => {
  const vip = ticketTypeRow({ id: "vip-id", code: "VIP", price: "1000.00" });
  const calls = arrange({ ticketTypes: [vip] });
  const isPaymentRequired = (error: unknown) =>
    error instanceof PaymentRequiredError && JSON.stringify(error.details) === JSON.stringify({ ticket_type_code: "VIP", price: "1000.00", currency: "ETB" });

  await assert.rejects(registrationService.registerGuest(IDS.orgA, IDS.event, { person_id: IDS.person, ticket_type_id: "vip-id" }, IDS.user), isPaymentRequired);
  await assert.rejects(registrationService.registerInTransaction(PUBLIC_INPUT, FAKE_TX), isPaymentRequired);
  assert.equal(calls.create.mock.callCount(), 0);
});

test("a guest can't be moved onto a paid type", async () => {
  const vip = ticketTypeRow({ id: "vip-id", code: "VIP", price: "1000.00" });
  arrange({ event: eventRow({ ...PUBLISHED }), ticketTypes: [ticketTypeRow(), vip] });
  mock.method(registrationRepository, "findByEventAndId", async () => registrationRow({ status: "CONFIRMED", ticket_type_id: IDS.ticketType }));
  const update = mock.method(registrationRepository, "updateByEventAndId", async () => registrationRow());

  await assert.rejects(registrationService.changeRegistrationTicketType(IDS.orgA, IDS.event, IDS.registration, "vip-id", IDS.user), PaymentRequiredError);
  assert.equal(update.mock.callCount(), 0);
});
