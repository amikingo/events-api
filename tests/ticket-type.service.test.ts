import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { Transaction } from "sequelize";
import { CapacityBelowRegistrationsError, ConflictError, InvalidEventStateError, ValidationAppError } from "../src/errors/app-errors.js";
import { eventRepository } from "../src/repositories/event.repository.js";
import { organizationRepository } from "../src/repositories/organization.repository.js";
import { registrationRepository } from "../src/repositories/registration.repository.js";
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

test("a ticket type's limit can't drop below its confirmed registrations; the count is read under the event lock", async () => {
  const findEvent = mock.method(eventRepository, "findByOrganizationAndId", async () => eventRow({ status: "PUBLISHED", capacity: null }));
  mock.method(ticketTypeRepository, "findByEventAndId", async () => ticketTypeRow({ capacity: 50 }));
  const count = mock.method(registrationRepository, "countConfirmedByTicketType", async () => 30);
  const update = mock.method(ticketTypeRepository, "updateByEventAndId", async () => ticketTypeRow({ capacity: 30 }));

  await assert.rejects(
    ticketTypeService.updateTicketType(IDS.orgA, IDS.event, IDS.ticketType, { capacity: 20 }, IDS.user),
    CapacityBelowRegistrationsError,
  );
  assert.equal(update.mock.callCount(), 0);
  assert.deepEqual(findEvent.mock.calls[0]?.arguments.slice(2), [{ transaction: FAKE_TX, lock: true }]);
  assert.deepEqual(count.mock.calls[0]?.arguments, [IDS.orgA, IDS.event, IDS.ticketType, { transaction: FAKE_TX }]);

  await ticketTypeService.updateTicketType(IDS.orgA, IDS.event, IDS.ticketType, { capacity: 30 }, IDS.user);
  assert.equal(update.mock.callCount(), 1, "exactly the confirmed count fits");
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
