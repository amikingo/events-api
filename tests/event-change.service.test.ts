import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import type { Transaction } from "sequelize";
import { EventHasAdmissionsError, InvalidEventStateError, ValidationAppError } from "../src/errors/app-errors.js";
import type { EventRow } from "../src/models/event.js";
import type { EventCancelledPayload, EventRescheduledPayload, MessageOutboxRow } from "../src/models/message-outbox.js";
import type { TicketOrderRow } from "../src/models/ticket-order.js";
import { eventRepository } from "../src/repositories/event.repository.js";
import { messageOutboxRepository } from "../src/repositories/message-outbox.repository.js";
import { orderPaymentRepository } from "../src/repositories/order-payment.repository.js";
import { organizationRepository } from "../src/repositories/organization.repository.js";
import { registrationRepository, type CancellableTicket } from "../src/repositories/registration.repository.js";
import { ticketAdmissionRepository } from "../src/repositories/ticket-admission.repository.js";
import { ticketOrderRepository } from "../src/repositories/ticket-order.repository.js";
import { eventChangeService } from "../src/services/event-change.service.js";
import { transactionManager } from "../src/services/helpers.js";
import { paymentCaseService, type AttemptCaseInput } from "../src/services/payment-case.service.js";
import { eventRow, IDS, orderPaymentRow, orderRow, organizationRow } from "./helpers/fixtures.js";

/** Event changes after sales (Phase 9) against in-memory fakes: cancelling and rescheduling. */
const FAKE_TX = { id: "fake-transaction" } as unknown as Transaction;
const PUBLISHED: Partial<EventRow> = { status: "PUBLISHED", published_at: new Date("2026-11-01T00:00:00Z") };

const ticket = (id: string, orderId: string, price: string, admitted = false): CancellableTicket => ({ id, order_id: orderId, status: "CONFIRMED", price_amount: price, currency: "ETB", admitted });

function arrangeCancel(options: { event?: Partial<EventRow>; admissions?: number; tickets?: CancellableTicket[]; pending?: TicketOrderRow[]; orders?: TicketOrderRow[] } = {}) {
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
  const event = eventRow({ ...PUBLISHED, name: "Jazz Night", ...options.event });
  mock.method(eventRepository, "findByOrganizationAndId", async () => event);
  const update = mock.method(eventRepository, "updateByOrganizationAndId", async (_o: string, _e: string, values: Partial<EventRow>) => ({ ...event, ...values }));
  mock.method(ticketAdmissionRepository, "countByEvent", async () => options.admissions ?? 0);
  mock.method(ticketOrderRepository, "listPendingByEvent", async () => options.pending ?? []);
  const orderUpdate = mock.method(ticketOrderRepository, "updateById", async () => undefined);
  const release = mock.method(registrationRepository, "releaseHeldByOrder", async () => 1);
  mock.method(registrationRepository, "listConfirmedWithAdmission", async () => options.tickets ?? []);
  const cancelled = mock.method(registrationRepository, "cancelByIds", async (_o: string, _e: string, ids: readonly string[]) => ids.length);
  mock.method(ticketOrderRepository, "listByEventAndIds", async (_o: string, _e: string, ids: readonly string[]) => (options.orders ?? []).filter((order) => ids.includes(order.id)));
  mock.method(orderPaymentRepository, "findByOrder", async (_o: string, orderId: string) => orderPaymentRow({ id: `pay-${orderId}`, order_id: orderId, status: "PAID", paid_tx_ref: `tx-${orderId}` }));
  const cases: AttemptCaseInput[] = [];
  mock.method(paymentCaseService, "openForAttempt", async (input: AttemptCaseInput) => {
    if (!cases.some((entry) => entry.txRef === input.txRef)) cases.push(input);
    return {} as never;
  });
  mock.method(organizationRepository, "findById", async () => organizationRow({ name: "Selam Events" }));
  const messages: Array<Partial<MessageOutboxRow>> = [];
  mock.method(messageOutboxRepository, "create", async (values: Partial<MessageOutboxRow>) => {
    messages.push(values);
    return {} as never;
  });
  return { update, orderUpdate, release, cancelled, cases, messages };
}

afterEach(() => mock.restoreAll());

const ORDERS = [
  orderRow({ id: "order-a", buyer_mobile: "+251911000001", currency: "ETB" }),
  orderRow({ id: "order-b", buyer_mobile: "+251911000002", currency: "ETB" }),
  orderRow({ id: "order-c", buyer_mobile: null, currency: "ETB" }),
];
const TICKETS = [
  ticket("a1", "order-a", "500.00"),
  ticket("a2", "order-a", "500.00"),
  ticket("a3", "order-a", "1000.00", true),
  ticket("b1", "order-b", "0.00"),
  ticket("b2", "order-b", "300.00"),
  ticket("c1", "order-c", "0.00"),
];

test("cancelling: holds released once, unused tickets cancelled, admitted ones kept, one case per paid order for its unused paid tickets, one SMS per order with a mobile", async () => {
  const held = orderRow({ id: "order-held", status: "PENDING_PAYMENT", buyer_mobile: "+251911000009" });
  const fakes = arrangeCancel({ admissions: 1, tickets: TICKETS, orders: ORDERS, pending: [held] });
  const event = await eventChangeService.cancel(IDS.orgA, IDS.event, { refundAdmittedTickets: false }, IDS.user);

  assert.deepEqual(fakes.release.mock.calls.map((call) => call.arguments[2]), ["order-held"]);
  assert.deepEqual(fakes.orderUpdate.mock.calls.map((call) => [call.arguments[1], call.arguments[2]]), [["order-held", { status: "EXPIRED" }]]);
  assert.deepEqual([...(fakes.cancelled.mock.calls[0]?.arguments[2] ?? [])].sort(), ["a1", "a2", "b1", "b2", "c1"], "the admitted ticket a3 is kept");
  assert.deepEqual(
    fakes.cases.map((entry) => [entry.kind, entry.orderId, entry.txRef, entry.amount]),
    [
      ["EVENT_CANCELLATION", "order-a", "tx-order-a", "1000.00"],
      ["EVENT_CANCELLATION", "order-b", "tx-order-b", "300.00"],
    ],
    "unused paid tickets at their checkout price; free tickets add nothing; a free order has no case",
  );
  assert.deepEqual(
    fakes.messages.map((message) => [message.kind, message.order_id, (message.payload as EventCancelledPayload).refund_amount]),
    [
      ["EVENT_CANCELLED", "order-a", "1000.00"],
      ["EVENT_CANCELLED", "order-b", "300.00"],
      ["EVENT_CANCELLED", "order-held", "0.00"],
    ],
    "order C has no mobile",
  );
  assert.deepEqual([event.status, event.refund_admitted_tickets, event.cancelled_by], ["CANCELLED", false, IDS.user]);
  assert.ok(event.cancelled_at instanceof Date);
});

test("with the organizer's approval, used paid tickets are refunded too; with admissions, the decision is required", async () => {
  const approved = arrangeCancel({ admissions: 1, tickets: TICKETS, orders: ORDERS });
  await eventChangeService.cancel(IDS.orgA, IDS.event, { refundAdmittedTickets: true }, IDS.user);
  assert.equal(approved.cases.find((entry) => entry.orderId === "order-a")?.amount, "2000.00");
  mock.restoreAll();

  const undecided = arrangeCancel({ admissions: 1, tickets: TICKETS, orders: ORDERS });
  await assert.rejects(eventChangeService.cancel(IDS.orgA, IDS.event, {}, IDS.user), (error: unknown) => {
    assert.ok(error instanceof ValidationAppError);
    return JSON.stringify(error.details).includes("refund_decision_required");
  });
  assert.equal(undecided.cancelled.mock.callCount(), 0);
  mock.restoreAll();

  const none = arrangeCancel({ admissions: 0, tickets: [ticket("x", "order-a", "500.00")], orders: ORDERS });
  const event = await eventChangeService.cancel(IDS.orgA, IDS.event, {}, IDS.user);
  assert.equal(event.refund_admitted_tickets, null, "nothing to decide without admissions");
  assert.equal(none.cases.length, 1);
});

test("cancelling again changes nothing; a CLOSED event can't be cancelled; a draft cancels with nothing to settle", async () => {
  const again = arrangeCancel({ event: { status: "CANCELLED", cancelled_at: new Date() } });
  await eventChangeService.cancel(IDS.orgA, IDS.event, {}, IDS.user);
  assert.equal(again.update.mock.callCount(), 0);
  assert.equal(again.messages.length, 0);
  mock.restoreAll();

  arrangeCancel({ event: { status: "CLOSED" } });
  await assert.rejects(eventChangeService.cancel(IDS.orgA, IDS.event, {}, IDS.user), InvalidEventStateError);
  mock.restoreAll();

  const draft = arrangeCancel({ event: { status: "DRAFT", published_at: null } });
  assert.equal((await eventChangeService.cancel(IDS.orgA, IDS.event, {}, IDS.user)).status, "CANCELLED");
  assert.equal(draft.messages.length, 0);
});

// --- Reschedule ------------------------------------------------------------------------------------------

const FRIDAY = { starts_at: new Date("2027-03-12T15:00:00Z"), ends_at: new Date("2027-03-12T20:00:00Z") };
const SUNDAY = { starts_at: new Date("2027-03-14T15:00:00Z"), ends_at: new Date("2027-03-14T20:00:00Z") };

function arrangeReschedule(admissions = 0) {
  mock.method(ticketAdmissionRepository, "countByEvent", async () => admissions);
  mock.method(registrationRepository, "listOrderIdsWithConfirmed", async () => ["order-a", "order-c"]);
  mock.method(ticketOrderRepository, "listByEventAndIds", async (_o: string, _e: string, ids: readonly string[]) => ORDERS.filter((order) => ids.includes(order.id)));
  mock.method(organizationRepository, "findById", async () => organizationRow({ name: "Selam Events" }));
  const messages: Array<Partial<MessageOutboxRow>> = [];
  mock.method(messageOutboxRepository, "create", async (values: Partial<MessageOutboxRow>) => {
    messages.push(values);
    return {} as never;
  });
  return { messages };
}

test("a published event moves as a whole, re-confirms its own door time, and only before the first admission; a draft moves freely", async () => {
  arrangeReschedule();
  const published = eventRow({ ...PUBLISHED, ...FRIDAY });
  await assert.rejects(eventChangeService.assertReschedulable(published, { starts_at: SUNDAY.starts_at }, FAKE_TX), (error: unknown) => JSON.stringify((error as ValidationAppError).details).includes("schedule_pair_required"));
  await eventChangeService.assertReschedulable(published, SUNDAY, FAKE_TX);
  await eventChangeService.assertReschedulable(published, FRIDAY, FAKE_TX); // the same values: no change, no rules

  const withDoors = eventRow({ ...PUBLISHED, ...FRIDAY, doors_open_at: new Date("2027-03-12T14:00:00Z") });
  await assert.rejects(eventChangeService.assertReschedulable(withDoors, SUNDAY, FAKE_TX), (error: unknown) => JSON.stringify((error as ValidationAppError).details).includes("doors_open_at_reconfirm"));
  await eventChangeService.assertReschedulable(withDoors, { ...SUNDAY, doors_open_at: null }, FAKE_TX);
  mock.restoreAll();

  arrangeReschedule(1);
  await assert.rejects(eventChangeService.assertReschedulable(published, SUNDAY, FAKE_TX), EventHasAdmissionsError);
  await eventChangeService.assertReschedulable(eventRow({ ...FRIDAY, status: "DRAFT", published_at: null }), { starts_at: SUNDAY.starts_at }, FAKE_TX);
});

test("an actual move tells each order with issued tickets and a mobile once, with the door time when it differs; the same values send nothing", async () => {
  const { messages } = arrangeReschedule();
  const before = eventRow({ ...PUBLISHED, ...FRIDAY });
  const after = eventRow({ ...PUBLISHED, ...SUNDAY, doors_open_at: new Date("2027-03-14T14:00:00Z") });
  assert.equal(await eventChangeService.notifyRescheduled(before, after, FAKE_TX), 1, "order C has no mobile");
  const payload = messages[0]?.payload as EventRescheduledPayload;
  assert.deepEqual([messages[0]?.kind, messages[0]?.order_id, payload.starts_at, payload.doors_open_at], ["EVENT_RESCHEDULED", "order-a", SUNDAY.starts_at.toISOString(), "2027-03-14T14:00:00.000Z"]);
  assert.equal(await eventChangeService.notifyRescheduled(after, after, FAKE_TX), 0);
  assert.equal(await eventChangeService.notifyRescheduled(eventRow({ ...FRIDAY, published_at: null }), eventRow({ ...SUNDAY, published_at: null }), FAKE_TX), 0, "never published: nobody to tell");
});
