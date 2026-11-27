import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { Transaction } from "sequelize";
import { CapacityBelowRegistrationsError, ConflictError, InvalidEventStateError, ValidationAppError } from "../src/errors/app-errors.js";
import { eventRepository } from "../src/repositories/event.repository.js";
import { organizationRepository } from "../src/repositories/organization.repository.js";
import { registrationRepository } from "../src/repositories/registration.repository.js";
import { ticketTypePriceWindowRepository, type PriceWindowValues } from "../src/repositories/ticket-type-price-window.repository.js";
import { ticketTypeRepository } from "../src/repositories/ticket-type.repository.js";
import { transactionManager } from "../src/services/helpers.js";
import { ticketTypeService } from "../src/services/ticket-type.service.js";
import { eventRow, IDS, organizationRow, ticketTypeRow } from "./helpers/fixtures.js";

/** The ticket type service against mocked repositories and a fake transaction: no database needed. */
const FAKE_TX = { id: "fake-transaction" } as unknown as Transaction;
const VIP = { code: "VIP", name: "VIP" };

beforeEach(() => {
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
  mock.method(ticketTypeRepository, "findByEventAndCode", async () => null);
  mock.method(ticketTypeRepository, "maxDisplayOrderByEvent", async () => 0);
  mock.method(organizationRepository, "findById", async () => organizationRow({ default_currency: "ETB" }));
  // Phase 11: no price schedule unless a test says otherwise.
  mock.method(ticketTypePriceWindowRepository, "listByTicketTypes", async () => []);
  mock.method(ticketTypePriceWindowRepository, "replaceForTicketType", async () => []);
});
afterEach(() => mock.restoreAll());

test("a ticket type's own limit must fit within the event's capacity; limits may add up to more", async () => {
  const findEvent = mock.method(eventRepository, "findByOrganizationAndId", async () => eventRow({ capacity: 500 }));
  const create = mock.method(ticketTypeRepository, "create", async () => ticketTypeRow({ code: "VIP" }));

  await assert.rejects(ticketTypeService.createTicketType(IDS.orgA, IDS.event, { ...VIP, capacity: 600 }, IDS.user), ValidationAppError);
  assert.equal(create.mock.callCount(), 0);

  await ticketTypeService.createTicketType(IDS.orgA, IDS.event, { ...VIP, capacity: 500 }, IDS.user);
  const [values, options] = create.mock.calls[0]?.arguments ?? [];
  assert.deepEqual([values?.code, values?.capacity, values?.display_order], ["VIP", 500, 1], "placed after the last ticket type");
  assert.deepEqual(options, { transaction: FAKE_TX });
  assert.deepEqual(findEvent.mock.calls[0]?.arguments.slice(2), [{ transaction: FAKE_TX, lock: true }], "the event is locked first");
});

test("an event without a capacity accepts any ticket limit", async () => {
  mock.method(eventRepository, "findByOrganizationAndId", async () => eventRow({ capacity: null }));
  const create = mock.method(ticketTypeRepository, "create", async () => ticketTypeRow({ code: "VIP" }));
  await ticketTypeService.createTicketType(IDS.orgA, IDS.event, { ...VIP, capacity: 10_000 }, IDS.user);
  assert.equal(create.mock.callCount(), 1);
});

test("a code already used in the event is refused", async () => {
  mock.method(eventRepository, "findByOrganizationAndId", async () => eventRow());
  mock.method(ticketTypeRepository, "findByEventAndCode", async () => ticketTypeRow({ id: "another", code: "VIP" }));
  await assert.rejects(ticketTypeService.createTicketType(IDS.orgA, IDS.event, { ...VIP }, IDS.user), ConflictError);
});

test("a published event must keep at least one active ticket type", async () => {
  mock.method(eventRepository, "findByOrganizationAndId", async () => eventRow({ status: "PUBLISHED" }));
  mock.method(ticketTypeRepository, "findByEventAndId", async () => ticketTypeRow());
  mock.method(ticketTypeRepository, "countActiveByEvent", async () => 1);
  const update = mock.method(ticketTypeRepository, "updateByEventAndId", async () => ticketTypeRow({ is_active: false }));

  await assert.rejects(ticketTypeService.changeTicketTypeStatus(IDS.orgA, IDS.event, IDS.ticketType, false, IDS.user), InvalidEventStateError);
  assert.equal(update.mock.callCount(), 0);
});

test("a draft may deactivate its only ticket type (it just can't be published until one is active)", async () => {
  mock.method(eventRepository, "findByOrganizationAndId", async () => eventRow({ status: "DRAFT" }));
  mock.method(ticketTypeRepository, "findByEventAndId", async () => ticketTypeRow());
  mock.method(ticketTypeRepository, "countActiveByEvent", async () => 1);
  const update = mock.method(ticketTypeRepository, "updateByEventAndId", async () => ticketTypeRow({ is_active: false }));

  await ticketTypeService.changeTicketTypeStatus(IDS.orgA, IDS.event, IDS.ticketType, false, IDS.user);
  assert.equal(update.mock.callCount(), 1);
});

test("a CLOSED or CANCELLED event's ticket types can no longer change", async () => {
  for (const status of ["CLOSED", "CANCELLED"] as const) {
    mock.method(eventRepository, "findByOrganizationAndId", async () => eventRow({ status }));
    const create = mock.method(ticketTypeRepository, "create", async () => ticketTypeRow());
    await assert.rejects(ticketTypeService.createTicketType(IDS.orgA, IDS.event, { ...VIP }, IDS.user), InvalidEventStateError, status);
    assert.equal(create.mock.callCount(), 0);
  }
});

test("a ticket type's limit can't drop below its confirmed tickets and active holds; the count is read under the event lock", async () => {
  const findEvent = mock.method(eventRepository, "findByOrganizationAndId", async () => eventRow({ status: "PUBLISHED", capacity: null }));
  mock.method(ticketTypeRepository, "findByEventAndId", async () => ticketTypeRow({ capacity: 50 }));
  const count = mock.method(registrationRepository, "countSecured", async () => ({ confirmed: 25, held: 5 }));
  const update = mock.method(ticketTypeRepository, "updateByEventAndId", async () => ticketTypeRow({ capacity: 30 }));

  await assert.rejects(
    ticketTypeService.updateTicketType(IDS.orgA, IDS.event, IDS.ticketType, { capacity: 20 }, IDS.user),
    CapacityBelowRegistrationsError,
  );
  assert.equal(update.mock.callCount(), 0);
  assert.deepEqual(findEvent.mock.calls[0]?.arguments.slice(2), [{ transaction: FAKE_TX, lock: true }]);
  const [organizationId, eventId, now, ticketTypeId, options] = count.mock.calls[0]?.arguments ?? [];
  assert.deepEqual([organizationId, eventId, now instanceof Date, ticketTypeId, options], [IDS.orgA, IDS.event, true, IDS.ticketType, { transaction: FAKE_TX }]);

  await ticketTypeService.updateTicketType(IDS.orgA, IDS.event, IDS.ticketType, { capacity: 30 }, IDS.user);
  assert.equal(update.mock.callCount(), 1, "exactly confirmed plus held fits");
});

// --- Phase 7 step 1 ------------------------------------------------------------------------------------

test("a new ticket type is free and public unless told otherwise, in the organizer's currency", async () => {
  mock.method(eventRepository, "findByOrganizationAndId", async () => eventRow());
  mock.method(organizationRepository, "findById", async () => organizationRow({ default_currency: "USD" }));
  const create = mock.method(ticketTypeRepository, "create", async () => ticketTypeRow());

  await ticketTypeService.createTicketType(IDS.orgA, IDS.event, { ...VIP }, IDS.user);
  await ticketTypeService.createTicketType(IDS.orgA, IDS.event, { code: "CREW", name: "Crew", price: "500.00", audience: "STAFF_ONLY" }, IDS.user);

  const [free, paid] = create.mock.calls.map((call) => call.arguments[0]);
  assert.deepEqual([free?.price, free?.currency, free?.audience], ["0.00", "USD", "PUBLIC"]);
  assert.deepEqual([paid?.price, paid?.currency, paid?.audience], ["500.00", "USD", "STAFF_ONLY"]);
});

test("price and audience can change later; the currency can't be sent", async () => {
  mock.method(eventRepository, "findByOrganizationAndId", async () => eventRow({ status: "PUBLISHED" }));
  mock.method(ticketTypeRepository, "findByEventAndId", async () => ticketTypeRow());
  const update = mock.method(ticketTypeRepository, "updateByEventAndId", async () => ticketTypeRow({ price: "250.00" }));

  await ticketTypeService.updateTicketType(IDS.orgA, IDS.event, IDS.ticketType, { price: "250.00", audience: "STAFF_ONLY" }, IDS.user);
  assert.deepEqual(update.mock.calls[0]?.arguments[3], { price: "250.00", audience: "STAFF_ONLY", updated_by: IDS.user });
});

// --- Phase 11: price windows ----------------------------------------------------------------------------

const at = (time: string) => new Date(`2027-07-01T${time}:00+03:00`);
const EVENING = { starts_at: at("18:00"), ends_at: at("20:00"), price: "700.00" };
const storedWindows = (windows: readonly PriceWindowValues[]) =>
  windows.map((window, index) => ({ ...window, id: `window-${index}`, organization_id: IDS.orgA, event_id: IDS.event, ticket_type_id: IDS.ticketType, created_at: new Date(), created_by: IDS.user }));

test("Phase 11: a schedule replaces the old one as a whole under the event and ticket-type locks; the reply keeps the regular price apart from the effective one", async () => {
  const findEvent = mock.method(eventRepository, "findByOrganizationAndId", async () => eventRow({ status: "PUBLISHED" }));
  const findType = mock.method(ticketTypeRepository, "findByEventAndId", async () => ticketTypeRow({ price: "500.00" }));
  mock.method(ticketTypeRepository, "updateByEventAndId", async () => ticketTypeRow({ price: "500.00" }));
  // An earlier window that has ended, then an open-ended one running now (open-ended must come last).
  const earlier = { starts_at: new Date(Date.now() - 120 * 60_000), ends_at: new Date(Date.now() - 60 * 60_000), price: "300.00" };
  const open = { starts_at: new Date(Date.now() - 60_000), ends_at: null, price: "650.00" };
  const replace = mock.method(
    ticketTypePriceWindowRepository,
    "replaceForTicketType",
    async (_o: string, _e: string, _id: string, windows: readonly PriceWindowValues[], _actor: string | null, _options: { transaction: Transaction }) => storedWindows(windows),
  );

  const reply = await ticketTypeService.updateTicketType(IDS.orgA, IDS.event, IDS.ticketType, { price_windows: [earlier, open] }, IDS.user);

  const [org, event, typeId, windows, actor, options] = replace.mock.calls[0]?.arguments ?? [];
  assert.deepEqual([org, event, typeId, actor, options], [IDS.orgA, IDS.event, IDS.ticketType, IDS.user, { transaction: FAKE_TX }]);
  assert.deepEqual(windows, [earlier, open], "an omitted end is stored as null");
  assert.deepEqual(findEvent.mock.calls[0]?.arguments.slice(2), [{ transaction: FAKE_TX, lock: true }], "the event first");
  assert.deepEqual(findType.mock.calls[0]?.arguments.slice(3), [{ transaction: FAKE_TX, lock: true }], "then the ticket type");
  assert.deepEqual([reply.price, reply.effective_price, reply.effective_is_free, reply.price_valid_until], ["500.00", "650.00", false, null]);
  assert.equal(reply.price_windows.length, 2);
});

test("Phase 11: leaving price_windows out keeps the schedule; [] clears it", async () => {
  mock.method(eventRepository, "findByOrganizationAndId", async () => eventRow({ status: "PUBLISHED" }));
  mock.method(ticketTypeRepository, "findByEventAndId", async () => ticketTypeRow());
  mock.method(ticketTypeRepository, "updateByEventAndId", async () => ticketTypeRow({ name: "General" }));
  const replace = mock.method(ticketTypePriceWindowRepository, "replaceForTicketType", async () => []);
  const read = mock.method(ticketTypePriceWindowRepository, "listByTicketTypes", async () => storedWindows([EVENING]));

  const kept = await ticketTypeService.updateTicketType(IDS.orgA, IDS.event, IDS.ticketType, { name: "General" }, IDS.user);
  assert.equal(replace.mock.callCount(), 0);
  assert.equal(read.mock.callCount(), 1);
  assert.equal(kept.price_windows.length, 1, "the schedule is still there");

  const cleared = await ticketTypeService.updateTicketType(IDS.orgA, IDS.event, IDS.ticketType, { price_windows: [] }, IDS.user);
  assert.deepEqual(replace.mock.calls[0]?.arguments[3], []);
  assert.deepEqual(cleared.price_windows, []);
});

test("Phase 11: overlapping windows, two open-ended windows or an end before its start are refused as a whole before anything is read or written", async () => {
  const findEvent = mock.method(eventRepository, "findByOrganizationAndId", async () => eventRow({ status: "PUBLISHED" }));
  const replace = mock.method(ticketTypePriceWindowRepository, "replaceForTicketType", async () => []);
  const cases = [
    { windows: [EVENING, { starts_at: at("19:00"), ends_at: at("21:00"), price: "800.00" }], expected: [["body.price_windows.1", "overlapping_window"]] },
    { windows: [{ starts_at: at("18:00"), price: "700.00" }, { starts_at: at("21:00"), price: "800.00" }], expected: [["body.price_windows.1", "overlapping_window"]] },
    { windows: [{ starts_at: at("20:00"), ends_at: at("19:00"), price: "700.00" }], expected: [["body.price_windows.0", "invalid_range"]] },
  ];
  for (const { windows, expected } of cases) {
    await assert.rejects(ticketTypeService.updateTicketType(IDS.orgA, IDS.event, IDS.ticketType, { price_windows: windows }, IDS.user), (error: unknown) => {
      assert.ok(error instanceof ValidationAppError);
      assert.deepEqual((error.details as { issues: Array<{ path: string; code: string }> }).issues.map((issue) => [issue.path, issue.code]), expected);
      return true;
    });
  }
  assert.equal(findEvent.mock.callCount(), 0);
  assert.equal(replace.mock.callCount(), 0);
});

test("Phase 11: a new ticket type may come with its schedule, stored in the same transaction; adjacent windows are fine", async () => {
  mock.method(eventRepository, "findByOrganizationAndId", async () => eventRow());
  mock.method(ticketTypeRepository, "create", async () => ticketTypeRow({ price: "500.00" }));
  const replace = mock.method(ticketTypePriceWindowRepository, "replaceForTicketType", async (_o: string, _e: string, _id: string, windows: readonly PriceWindowValues[]) => storedWindows(windows));
  const late = { starts_at: at("20:00"), ends_at: at("22:00"), price: "800.00" };
  const created = await ticketTypeService.createTicketType(IDS.orgA, IDS.event, { code: "GA", name: "General Admission", price: "500.00", price_windows: [EVENING, late] }, IDS.user);
  assert.equal(replace.mock.calls[0]?.arguments[5]?.transaction, FAKE_TX);
  assert.equal(created.price_windows.length, 2);
  assert.equal(created.price, "500.00");
});
