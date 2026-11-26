import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import type { Transaction } from "sequelize";
import { IdempotencyKeyReusedError, InvalidEventStateError, NotFoundError, TicketNotAdmissibleError } from "../src/errors/app-errors.js";
import type { RegistrationRow } from "../src/models/registration.js";
import type { TicketAdmissionRow } from "../src/models/ticket-admission.js";
import { eventRepository } from "../src/repositories/event.repository.js";
import { registrationRepository } from "../src/repositories/registration.repository.js";
import { ticketAdmissionRepository } from "../src/repositories/ticket-admission.repository.js";
import { checkInService } from "../src/services/check-in.service.js";
import { transactionManager } from "../src/services/helpers.js";
import { eventRow, IDS, orderSummary, personRow, registrationRow, ticketTypeRow } from "./helpers/fixtures.js";

/** Admission at the door (Phase 8 step 2) against in-memory fakes: results, retries, refusals and the lock. */
const FAKE_TX = { id: "fake-transaction" } as unknown as Transaction;
const CODE = "K7M2Q9XP";
const KEY = "gate-1-scan-0001";

type State = { ticket: RegistrationRow | null; admissions: TicketAdmissionRow[]; locks: string[] };
let state: State;

function arrange(options: { ticket?: Partial<RegistrationRow> | null; event?: Parameters<typeof eventRow>[0]; admissions?: Array<Partial<TicketAdmissionRow>>; raceOnce?: boolean } = {}) {
  state = {
    ticket: options.ticket === null ? null : registrationRow({ code: CODE, status: "CONFIRMED", ...options.ticket }),
    admissions: (options.admissions ?? []).map((row, index) => ({
      id: `admission-${index}`,
      organization_id: IDS.orgA,
      event_id: IDS.event,
      registration_id: IDS.registration,
      admitted_at: new Date("2026-11-27T09:00:00Z"),
      admitted_by: "staff-earlier",
      idempotency_key: "earlier-key-0001",
      created_at: new Date("2026-11-27T09:00:00Z"),
      ...row,
    })),
    locks: [],
  };
  let raced = options.raceOnce === true;
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
  mock.method(eventRepository, "findByOrganizationAndId", async (_o: string, _e: string, repo?: { lock?: boolean | "keyShare" }) => {
    if (repo?.lock) state.locks.push(`event:${String(repo.lock)}`);
    return eventRow({ status: "PUBLISHED", ...options.event });
  });
  mock.method(registrationRepository, "findByEventAndCode", async (_o: string, _e: string, code: string, repo?: { lock?: boolean }) => {
    if (repo?.lock) state.locks.push(`registration:${code}`);
    return state.ticket?.code === code ? { ...state.ticket } : null;
  });
  mock.method(registrationRepository, "findByEventAndId", async (_o: string, _e: string, id: string) => (state.ticket?.id === id ? { ...state.ticket } : null));
  mock.method(registrationRepository, "findDetailsByEventAndId", async () => ({
    ...(state.ticket as RegistrationRow),
    person: personRow(),
    ticketType: ticketTypeRow({ code: "GA", name: "General Admission" }),
    order: orderSummary({ reference: "ABCDE23456" }),
  }));
  mock.method(ticketAdmissionRepository, "findByKey", async (_o: string, key: string) => state.admissions.find((row) => row.idempotency_key === key) ?? null);
  mock.method(ticketAdmissionRepository, "findByRegistration", async (_o: string, id: string) => state.admissions.find((row) => row.registration_id === id) ?? null);
  const create = mock.method(ticketAdmissionRepository, "createUnlessTaken", async (values: Partial<TicketAdmissionRow>, repo: { transaction?: unknown }) => {
    assert.equal(repo.transaction, FAKE_TX, "inside the transaction that holds the registration lock");
    if (raced) {
      // Another request with this key admitted a ticket between our read and our insert.
      raced = false;
      state.admissions.push({ ...(state.admissions[0] as TicketAdmissionRow), ...values, id: "raced", admitted_at: new Date(), idempotency_key: KEY });
      return null;
    }
    const row = { id: `admission-${state.admissions.length}`, admitted_at: new Date("2026-11-27T10:00:00Z"), created_at: new Date(), ...values } as TicketAdmissionRow;
    state.admissions.push(row);
    return row;
  });
  return { create };
}

const input = (overrides: Partial<Parameters<typeof checkInService.admit>[0]> = {}) => ({ organizationId: IDS.orgA, eventId: IDS.event, code: CODE, idempotencyKey: KEY, actorId: IDS.user, ...overrides });

afterEach(() => mock.restoreAll());

test("a confirmed ticket is admitted once: the registration is locked, the staff member and time are recorded, and the ticket type comes back", async () => {
  const { create } = arrange();
  const result = await checkInService.admit(input());
  assert.deepEqual([result.result, result.checked_in_by, result.ticket.code, result.ticket.ticket_type.name, result.ticket.order.reference], ["ADMITTED", IDS.user, CODE, "General Admission", "ABCDE23456"]);
  assert.deepEqual(state.locks, ["event:keyShare", `registration:${CODE}`], "the event (key share) before the registration, like every other path");
  assert.deepEqual(create.mock.calls[0]?.arguments[0], { organization_id: IDS.orgA, event_id: IDS.event, registration_id: IDS.registration, admitted_by: IDS.user, idempotency_key: KEY });
});

test("the same request again (a lost response) returns its original result; a separate scan is ALREADY_CHECKED_IN with the original time", async () => {
  const { create } = arrange();
  const first = await checkInService.admit(input());
  const retried = await checkInService.admit(input());
  assert.deepEqual([retried.result, retried.checked_in_at, retried.checked_in_by], ["ADMITTED", first.checked_in_at, IDS.user]);
  const other = await checkInService.admit(input({ idempotencyKey: "gate-2-scan-0001", actorId: "staff-2" }));
  assert.deepEqual([other.result, other.checked_in_at, other.checked_in_by], ["ALREADY_CHECKED_IN", first.checked_in_at, IDS.user], "the original admission, not the second gate's");
  assert.equal(create.mock.callCount(), 1, "one admission");
});

test("the same key sent again while the first is still running is decided under the lock as that same admission", async () => {
  arrange({ admissions: [{ idempotency_key: KEY, admitted_by: IDS.user }] });
  mock.method(ticketAdmissionRepository, "findByKey", async () => null); // the first request hadn't committed when this one looked
  assert.equal((await checkInService.admit(input())).result, "ADMITTED");
});

test("only a confirmed ticket of this event is admitted; refusals write nothing", async () => {
  for (const status of ["HELD", "RELEASED", "CANCELLED"] as const) {
    const { create } = arrange({ ticket: { status } });
    await assert.rejects(checkInService.admit(input()), (error: unknown) => error instanceof TicketNotAdmissibleError && (error.details as { status: string }).status === status);
    assert.equal(create.mock.callCount(), 0);
    mock.restoreAll();
  }
  arrange({ ticket: null });
  await assert.rejects(checkInService.admit(input()), NotFoundError, "another event's or organization's code is simply not found here");
  mock.restoreAll();
  arrange({ event: { status: "CANCELLED" } });
  await assert.rejects(checkInService.admit(input()), InvalidEventStateError);
});

test("a key that already admitted another ticket, or a ticket at another event, is idempotency_key_reused", async () => {
  arrange({ admissions: [{ idempotency_key: KEY, registration_id: IDS.registration }] });
  await assert.rejects(checkInService.admit(input({ code: "M2Q9XPK7" })), IdempotencyKeyReusedError);
  mock.restoreAll();
  arrange({ admissions: [{ idempotency_key: KEY, event_id: "another-event" }] });
  await assert.rejects(checkInService.admit(input()), IdempotencyKeyReusedError);
});

test("a unique-key race the lock couldn't serialize is decided by reading again", async () => {
  const { create } = arrange({ raceOnce: true });
  const result = await checkInService.admit(input());
  assert.equal(result.result, "ADMITTED", "the other request with this key admitted this ticket: the same result");
  assert.equal(create.mock.callCount(), 1);
});
