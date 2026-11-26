import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import type { Transaction } from "sequelize";
import { chechePayClient, type CreateOrderInput } from "../src/clients/cheche-pay.client.js";
import { ConflictError, NotFoundError, PaidSalesUnavailableError, PaymentProviderUnavailableError, ValidationAppError } from "../src/errors/app-errors.js";
import type { MessageOutboxRow, OrderConfirmationPayload } from "../src/models/message-outbox.js";
import type { OrderPaymentRow } from "../src/models/order-payment.js";
import type { RegistrationRow } from "../src/models/registration.js";
import type { TicketOrderRow } from "../src/models/ticket-order.js";
import { eventRepository } from "../src/repositories/event.repository.js";
import { messageOutboxRepository } from "../src/repositories/message-outbox.repository.js";
import { orderPaymentRepository } from "../src/repositories/order-payment.repository.js";
import { organizationRepository } from "../src/repositories/organization.repository.js";
import { registrationRepository, type RegistrationWithDetails } from "../src/repositories/registration.repository.js";
import { ticketOrderRepository } from "../src/repositories/ticket-order.repository.js";
import { ticketTypeRepository } from "../src/repositories/ticket-type.repository.js";
import { transactionManager } from "../src/services/helpers.js";
import { paymentService } from "../src/services/payment.service.js";
import { readChechePayNotification } from "../src/validators/payment.js";
import { eventRow, IDS, orderPaymentRow, orderRow, organizationRow, registrationRow, ticketTypeRow } from "./helpers/fixtures.js";

/**
 * Paid orders through Cheche Pay (Phase 7 step 3) against in-memory repository fakes and a stubbed Cheche Pay client:
 * the payment option check, createOrder, bookings' callback rules (issue once, mismatch, duplicates, contradictions,
 * other statuses), late payments and expiry.
 */
const FAKE_TX = { id: "fake-transaction" } as unknown as Transaction;
const PAYMENT_ID = "c0000000-0000-4000-8000-000000000001";

type State = { order: TicketOrderRow; payment: OrderPaymentRow; tickets: RegistrationRow[]; otherTaken: number; capacity: number | null; messages: Array<Partial<MessageOutboxRow>> };
let state: State;

function arrange(overrides: { order?: Partial<TicketOrderRow>; payment?: Partial<OrderPaymentRow>; capacity?: number | null; otherTaken?: number } = {}) {
  state = {
    order: orderRow({ id: "order-1", status: "PENDING_PAYMENT", total_amount: "2000.00", buyer_mobile: "+251911234567", hold_expires_at: new Date(Date.now() + 10 * 60_000), ...overrides.order }),
    payment: orderPaymentRow({ id: PAYMENT_ID, order_id: "order-1", ...overrides.payment }),
    tickets: [1, 2, 3].map((n) => registrationRow({ id: `ticket-${n}`, order_id: "order-1", status: "HELD", code: null, person_id: null })),
    otherTaken: overrides.otherTaken ?? 0,
    capacity: overrides.capacity ?? null,
    messages: [],
  };
  const taken = () => state.otherTaken + state.tickets.filter((ticket) => ticket.status === "CONFIRMED" || ticket.status === "HELD").length;
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
  mock.method(eventRepository, "findByOrganizationAndId", async () => eventRow({ status: "PUBLISHED", name: "Jazz Night", capacity: state.capacity }));
  mock.method(organizationRepository, "findById", async () => organizationRow({ name: "Selam Events", cheche_pay_service: "SELAM" }));
  mock.method(ticketOrderRepository, "findByOrganizationAndId", async () => ({ ...state.order }));
  mock.method(ticketOrderRepository, "updateById", async (_o: string, _id: string, values: Partial<TicketOrderRow>) => {
    Object.assign(state.order, values);
  });
  mock.method(ticketOrderRepository, "listExpiredPendingByEvent", async (_o: string, _e: string, now: Date) =>
    state.order.status === "PENDING_PAYMENT" && state.order.hold_expires_at !== null && state.order.hold_expires_at <= now ? [{ ...state.order }] : [],
  );
  mock.method(ticketOrderRepository, "listExpiredPending", async (now: Date) =>
    state.order.status === "PENDING_PAYMENT" && state.order.hold_expires_at !== null && state.order.hold_expires_at <= now ? [{ ...state.order }] : [],
  );
  mock.method(orderPaymentRepository, "findByOrder", async () => ({ ...state.payment }));
  mock.method(orderPaymentRepository, "findById", async (id: string) => (id === state.payment.id ? { ...state.payment } : null));
  mock.method(orderPaymentRepository, "findByProviderOrderId", async (id: string) => (id === state.payment.provider_order_id ? { ...state.payment } : null));
  mock.method(orderPaymentRepository, "updateById", async (_id: string, values: Partial<OrderPaymentRow>) => {
    Object.assign(state.payment, values);
  });
  mock.method(registrationRepository, "listByOrder", async () => state.tickets.map((ticket) => ({ ...ticket }) as unknown as RegistrationWithDetails));
  mock.method(registrationRepository, "codeExists", async () => false);
  const issue = mock.method(registrationRepository, "issueHeld", async (_o: string, _e: string, id: string, code: string) => {
    Object.assign(state.tickets.find((row) => row.id === id) as RegistrationRow, { status: "CONFIRMED", code });
  });
  mock.method(registrationRepository, "releaseHeldByOrder", async () => {
    for (const ticket of state.tickets) if (ticket.status === "HELD") ticket.status = "RELEASED";
    return 3;
  });
  mock.method(registrationRepository, "countConfirmedByEvent", async () => taken());
  mock.method(registrationRepository, "countConfirmedByTicketType", async () => taken());
  mock.method(registrationRepository, "countConfirmedByBuyerMobile", async () => 0);
  mock.method(ticketTypeRepository, "findByEventAndId", async () => ticketTypeRow({ price: "500.00" }));
  mock.method(messageOutboxRepository, "create", async (values: Partial<MessageOutboxRow>) => {
    state.messages.push(values);
    return {} as never;
  });
  return { issue };
}

/** A callback as Cheche Pay sends it, read the way the controller reads it. */
const callback = (fields: Record<string, string>) =>
  readChechePayNotification({ transaction_id: PAYMENT_ID, trade_status: "Completed", transaction_amount: "2000", vendor_ref: "CP-REF-1", ...fields });

afterEach(() => mock.restoreAll());

test("a payment option must be one of the organizer's Cheche Pay options; no service code means paid sales are off", async () => {
  arrange();
  const list = mock.method(chechePayClient, "listPaymentOptions", async () => [{ id: "opt-telebirr", name: "Telebirr", raw: {} }]);
  assert.deepEqual(await paymentService.resolvePaymentOption(IDS.orgA, "opt-telebirr"), { optionId: "opt-telebirr", serviceCode: "SELAM" });
  assert.equal(list.mock.calls[0]?.arguments[0], "SELAM");
  await assert.rejects(paymentService.resolvePaymentOption(IDS.orgA, "opt-someone-else"), (error: unknown) => {
    assert.ok(error instanceof ValidationAppError);
    assert.equal((error.details as { issues: Array<{ code: string }> }).issues[0]?.code, "unknown_payment_option");
    return true;
  });
  mock.method(organizationRepository, "findById", async () => organizationRow({ cheche_pay_service: null }));
  await assert.rejects(paymentService.resolvePaymentOption(IDS.orgA, "opt-telebirr"), PaidSalesUnavailableError);
  assert.deepEqual(await paymentService.listOptionsForOrganization(IDS.orgA), [], "no code, no options");
});

test("starting payment calls createOrder with our payment id, the option, the amount and the buyer's mobile, and saves the checkout URL", async () => {
  arrange({ payment: { checkout_url: null } });
  const create = mock.method(chechePayClient, "createOrder", async (_input: CreateOrderInput) => ({ url: "https://pay.cheche.example/c/1", providerOrderId: "CP-ORDER-9", raw: { ok: true } }));
  await paymentService.startPayment(IDS.orgA, "order-1");
  assert.deepEqual(create.mock.calls[0]?.arguments[0], {
    paymentOptionId: "opt-telebirr",
    title: "Jazz Night",
    paymentType: "C2B",
    transactionId: PAYMENT_ID,
    userId: null,
    amount: "2000.00",
    phoneNumber: "+251911234567",
  });
  assert.deepEqual([state.payment.checkout_url, state.payment.provider_order_id], ["https://pay.cheche.example/c/1", "CP-ORDER-9"]);
  assert.equal((state.payment.request_object as { transaction_id: string }).transaction_id, PAYMENT_ID, "what was sent is kept for review");

  await paymentService.startPayment(IDS.orgA, "order-1");
  assert.equal(create.mock.callCount(), 1, "a checkout URL already saved is reused");
  mock.restoreAll();

  arrange({ payment: { checkout_url: null } });
  mock.method(chechePayClient, "createOrder", async () => {
    throw new PaymentProviderUnavailableError("Cheche Pay order creation failed (timed out)");
  });
  await assert.rejects(paymentService.startPayment(IDS.orgA, "order-1"), PaymentProviderUnavailableError);
  assert.deepEqual([state.payment.status, state.order.status, state.payment.last_error], ["INITIATED", "PENDING_PAYMENT", "Cheche Pay order creation failed (timed out)"], "nothing changes; retry with the same id");
});

test("a Completed callback for exactly the order issues every ticket once with one SMS; the same callback again changes nothing", async () => {
  const { issue } = arrange();
  const first = await paymentService.handleNotification(callback({}));
  assert.deepEqual([first.processed, first.order_status], [true, "CONFIRMED"]);
  assert.deepEqual([state.payment.status, state.payment.vendor_ref, state.payment.notify_time instanceof Date], ["PAID", "CP-REF-1", true]);
  assert.ok(state.tickets.every((ticket) => ticket.status === "CONFIRMED" && /^[A-HJKMNP-Z2-9]{8}$/.test(String(ticket.code))));
  assert.equal(new Set(state.tickets.map((ticket) => ticket.code)).size, 3);
  assert.deepEqual((state.messages[0]?.payload as OrderConfirmationPayload).codes, state.tickets.map((ticket) => ticket.code));

  const again = await paymentService.handleNotification(callback({ trade_status: "success" }));
  assert.deepEqual([again.duplicate, again.processed], [true, false]);
  assert.equal(issue.mock.callCount(), 3, "nothing issued twice");
  assert.equal(state.messages.length, 1, "one confirmation in total");

  await assert.rejects(paymentService.handleNotification(callback({ vendor_ref: "CP-REF-OTHER" })), ConflictError, "another Cheche Pay reference");
  await assert.rejects(paymentService.handleNotification(callback({ trade_status: "Failed" })), ConflictError, "contradictory after payment");
});

test("a Completed callback for another amount issues nothing and is kept as MISMATCH; a mismatched amount on any other status is refused", async () => {
  const { issue } = arrange();
  const result = await paymentService.handleNotification(callback({ transaction_amount: "20" }));
  assert.deepEqual([result.review_reason, result.processed, state.payment.status, state.order.status, issue.mock.callCount()], ["AMOUNT_MISMATCH", false, "MISMATCH", "PENDING_PAYMENT", 0]);
  assert.equal(state.messages.length, 0);
  await assert.rejects(paymentService.handleNotification(callback({ transaction_amount: "20", trade_status: "Pending" })), ConflictError);
});

test("any other status is acknowledged and changes nothing (the hold lapses on its own); an unknown payment is 404", async () => {
  arrange();
  const pending = await paymentService.handleNotification(callback({ trade_status: "Pending" }));
  assert.deepEqual([pending.processed, state.payment.status, state.order.status], [false, "INITIATED", "PENDING_PAYMENT"]);
  assert.equal(state.payment.last_notification?.trade_status, "Pending", "the callback is kept for review");
  await assert.rejects(paymentService.handleNotification(callback({ transaction_id: "c0000000-0000-4000-8000-00000000dead" })), NotFoundError);
});

test("as bookings, a callback without our id is matched by Cheche Pay's own order id when the amount agrees", async () => {
  arrange({ payment: { provider_order_id: "CP-ORDER-9" } });
  const fields = { trade_status: "Completed", transaction_amount: "2000.00", merch_order_id: "CP-ORDER-9" };
  const result = await paymentService.handleNotification(readChechePayNotification(fields));
  assert.equal(result.order_status, "CONFIRMED");
});

test("a payment after the places were released takes them again when there's room, and is REFUND_REQUIRED when there isn't", async () => {
  const roomy = arrange({ order: { hold_expires_at: new Date(Date.now() - 60_000) } });
  const late = await paymentService.handleNotification(callback({}));
  assert.equal(late.order_status, "CONFIRMED", "the lapsed hold was released, and the places were still free");
  assert.equal(roomy.issue.mock.callCount(), 3);
  mock.restoreAll();

  const full = arrange({ order: { status: "EXPIRED" }, capacity: 10, otherTaken: 9 });
  for (const ticket of state.tickets) ticket.status = "RELEASED";
  const refused = await paymentService.handleNotification(callback({}));
  assert.deepEqual([refused.order_status, refused.review_reason, state.payment.status], ["REFUND_REQUIRED", "PAID_AFTER_RELEASE", "PAID"], "the payment is kept for follow-up");
  assert.equal(full.issue.mock.callCount(), 0, "never oversold");
  assert.equal(state.messages.length, 0);
});

test("the worker releases unpaid holds past their time", async () => {
  arrange({ order: { hold_expires_at: new Date(Date.now() - 60_000) } });
  assert.deepEqual(await paymentService.processDue(new Date()), { expired: 1 });
  assert.equal(state.order.status, "EXPIRED");
  assert.ok(state.tickets.every((ticket) => ticket.status === "RELEASED"));
});

test("setting the service code warns when Cheche Pay has no options for it, as bookings does; null turns paid sales off", async () => {
  arrange();
  const save = mock.method(organizationRepository, "updateSettings", async () => organizationRow());
  mock.method(chechePayClient, "listPaymentOptions", async (code: string) => (code === "SELAM" ? [{ id: "opt-telebirr", name: "Telebirr", raw: {} }] : []));
  const ok = await paymentService.setChechePayService(IDS.orgA, "SELAM", IDS.user);
  assert.deepEqual([ok.paid_sales_available, ok.warnings.length, ok.payment_options], [true, 0, [{ id: "opt-telebirr", name: "Telebirr" }]]);
  const empty = await paymentService.setChechePayService(IDS.orgA, "NEWCODE", IDS.user);
  assert.deepEqual([empty.paid_sales_available, empty.warnings[0]?.code], [false, "CHECHE_PAY_SERVICE_HAS_NO_OPTIONS"]);
  const off = await paymentService.setChechePayService(IDS.orgA, null, IDS.user);
  assert.equal(off.paid_sales_available, false);
  assert.deepEqual(save.mock.calls.map((call) => (call.arguments[1] as { cheche_pay_service: string | null }).cheche_pay_service), ["SELAM", "NEWCODE", null]);
});

test("the callback's aliases follow bookings: vendor_ref, status and amount required; aliases must agree", () => {
  assert.deepEqual(readChechePayNotification({ transactionId: PAYMENT_ID, tradeStatus: "Completed", amount: "500", vendorReference: "R1" }), {
    transactionId: PAYMENT_ID,
    tradeStatus: "Completed",
    amount: "500.00",
    vendorRef: "R1",
    raw: { transactionId: PAYMENT_ID, tradeStatus: "Completed", amount: "500", vendorReference: "R1" },
  });
  assert.throws(() => readChechePayNotification({ transaction_id: PAYMENT_ID, trade_status: "Completed", amount: "500" }), ValidationAppError, "vendor_ref is required");
  assert.throws(() => readChechePayNotification({ trade_status: "Completed", amount: "500", vendor_ref: "A", trans_id: "B" }), ValidationAppError, "aliases disagree");
  assert.throws(() => readChechePayNotification({ trade_status: "Completed", amount: "5.555", vendor_ref: "A" }), ValidationAppError);
});
