import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { Transaction } from "sequelize";
import { ConflictError, InvalidEventStateError, ValidationAppError } from "../src/errors/app-errors.js";
import { eventRepository } from "../src/repositories/event.repository.js";
import { ticketTypeRepository } from "../src/repositories/ticket-type.repository.js";
import { transactionManager } from "../src/services/helpers.js";
import { ticketTypeService } from "../src/services/ticket-type.service.js";
import { eventRow, IDS, ticketTypeRow } from "./helpers/fixtures.js";

/** The ticket type service against mocked repositories and a fake transaction: no database needed. */
const FAKE_TX = { id: "fake-transaction" } as unknown as Transaction;
const VIP = { code: "VIP", name: "VIP" };

beforeEach(() => {
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
  mock.method(ticketTypeRepository, "findByEventAndCode", async () => null);
  mock.method(ticketTypeRepository, "maxDisplayOrderByEvent", async () => 0);
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
