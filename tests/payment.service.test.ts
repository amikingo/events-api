import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, mock, test } from "node:test";
import type { Transaction } from "sequelize";
import { chechePayClient, type InitializeInput, type VerifiedPayment } from "../src/clients/cheche-pay.client.js";
import {
  ConflictError,
  InvalidOrderStateError,
  InvalidSignatureError,
  NotFoundError,
  PaidSalesUnavailableError,
  PaymentProviderUnavailableError,
  ValidationAppError,
} from "../src/errors/app-errors.js";
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
import { chechePayCredentialService, type ChechePayKeys } from "../src/services/cheche-pay-credential.service.js";
import { paymentCaseService, type AttemptCaseInput } from "../src/services/payment-case.service.js";
import { transactionManager } from "../src/services/helpers.js";
import { paymentService } from "../src/services/payment.service.js";
import { eventRow, IDS, orderPaymentRow, orderRow, organizationRow, PAYMENT_ID, registrationRow, ticketTypeRow, TX_REF } from "./helpers/fixtures.js";

/**
 * Paid orders through Cheche Pay v2 (Phase 7 step 3b) against in-memory repository fakes and a stubbed Cheche Pay
 * client: starting an attempt, settling through merchant-verify (issue once, mismatch, duplicates, a second paid
 * attempt, other statuses), the webhook's signature, late payments and expiry.
 */
const FAKE_TX = { id: "fake-transaction" } as unknown as Transaction;
const KEYS: ChechePayKeys = { secretKey: "sk_test_secretvalue1234", webhookSecret: null, mode: "test" };

type State = { order: TicketOrderRow; payment: OrderPaymentRow; tickets: RegistrationRow[]; otherTaken: number; capacity: number | null; messages: Array<Partial<MessageOutboxRow>> };
let state: State;

function arrange(
  overrides: { order?: Partial<TicketOrderRow>; payment?: Partial<OrderPaymentRow>; capacity?: number | null; otherTaken?: number; keys?: ChechePayKeys | null; verified?: Partial<VerifiedPayment> | null } = {},
) {
  state = {
    order: orderRow({ id: "order-1", reference: "ABCDE23456", status: "PENDING_PAYMENT", total_amount: "2000.00", buyer_mobile: "+251911234567", hold_expires_at: new Date(Date.now() + 10 * 60_000), ...overrides.order }),
    payment: orderPaymentRow({ order_id: "order-1", ...overrides.payment }),
    tickets: [1, 2, 3].map((n) => registrationRow({ id: `ticket-${n}`, order_id: "order-1", status: "HELD", code: null, person_id: null })),
    otherTaken: overrides.otherTaken ?? 0,
    capacity: overrides.capacity ?? null,
    messages: [],
  };
  const taken = () => state.otherTaken + state.tickets.filter((ticket) => ticket.status === "CONFIRMED" || ticket.status === "HELD").length;
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
  mock.method(eventRepository, "findByOrganizationAndId", async () => eventRow({ status: "PUBLISHED", name: "Jazz Night", capacity: state.capacity }));
  mock.method(organizationRepository, "findById", async () => organizationRow({ name: "Selam Events" }));
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
  const keys = overrides.keys === undefined ? KEYS : overrides.keys;
  const resolve = mock.method(chechePayCredentialService, "resolve", async () => keys);
  mock.method(chechePayCredentialService, "requireForSale", async () => {
    if (!keys) throw new PaidSalesUnavailableError(undefined, { reason: "NO_CHECHE_PAY_KEYS" });
    return keys;
  });
  const verifiedAnswer = overrides.verified === undefined ? { status: "SUCCEEDED", amount: "2000", currency: "ETB" } : overrides.verified;
  const verify = mock.method(chechePayClient, "verify", async (): Promise<VerifiedPayment | null> =>
    verifiedAnswer === null ? null : { status: null, amount: null, currency: null, isFinal: true, transactionId: "cp-tx-1", raw: {}, ...verifiedAnswer },
  );
  const initialize = mock.method(chechePayClient, "initialize", async (input: InitializeInput) => ({
    checkoutUrl: `https://checkout.cheche.example/c/${input.txRef}`,
    txRef: input.txRef,
    transactionId: "cp-tx-2",
    expiresAt: new Date(Date.now() + 30 * 60_000),
    raw: { ok: true },
  }));
  // Phase 8: cases are opened through the case service (its own tests cover the one-per-attempt rule).
  const cases = new Map<string, { kind: string; amount: string; currency: string; orderPaymentId: string }>();
  const openCase = mock.method(paymentCaseService, "openForAttempt", async (input: AttemptCaseInput) => {
    if (!cases.has(input.txRef)) cases.set(input.txRef, { kind: input.kind, amount: input.amount, currency: input.currency, orderPaymentId: input.orderPaymentId });
    return {} as never;
  });
  return { issue, verify, initialize, resolve, openCase, cases };
}

afterEach(() => mock.restoreAll());

test("starting payment: transactions/initialize with the organizer's key, the amount, a fresh tx_ref and the return and callback URLs; the key is never stored", async () => {
  const { initialize } = arrange({ payment: { tx_ref: null, checkout_url: null } });
  const payment = await paymentService.startPayment(IDS.orgA, "order-1");
  const [input] = initialize.mock.calls[0]?.arguments ?? [];
  assert.ok(input);
  assert.equal(input.secretKey, KEYS.secretKey);
  assert.deepEqual([input.amount, input.phoneNumber], ["2000.00", "+251911234567"]);
  assert.equal(chechePayClient.parseTxRef(input.txRef), PAYMENT_ID, "the payment id is read back from the tx_ref");
  assert.equal(input.returnUrl, "https://events.example.test/orders/ABCDE23456");
  assert.equal(input.callbackUrl, `https://api.events.example.test/v1/payments/cheche/webhook/${IDS.orgA}`);
  assert.deepEqual([payment.tx_ref, payment.checkout_url, payment.provider_transaction_id, payment.key_mode], [input.txRef, `https://checkout.cheche.example/c/${input.txRef}`, "cp-tx-2", "test"]);
  assert.ok(!JSON.stringify(state.payment.request_object).includes(KEYS.secretKey), "the request kept for review has no key");
});

test("an unexpired checkout link is reused; an expired one is verified first, then a new attempt gets a new tx_ref", async () => {
  const fresh = arrange({ payment: { checkout_expires_at: new Date(Date.now() + 60_000) } });
  await paymentService.startPayment(IDS.orgA, "order-1");
  assert.equal(fresh.initialize.mock.callCount(), 0);
  mock.restoreAll();

  const expired = arrange({ payment: { checkout_expires_at: new Date(Date.now() - 60_000) }, verified: { status: "PENDING" } });
  const payment = await paymentService.startPayment(IDS.orgA, "order-1");
  assert.equal(expired.verify.mock.calls[0]?.arguments[1], TX_REF, "the last attempt is asked about first, so nobody pays twice");
  assert.equal(expired.initialize.mock.callCount(), 1);
  assert.notEqual(payment.tx_ref, TX_REF, "v2 refuses a reused tx_ref");
  mock.restoreAll();

  const alreadyPaid = arrange({ payment: { checkout_expires_at: new Date(Date.now() - 60_000) } });
  await paymentService.startPayment(IDS.orgA, "order-1");
  assert.equal(alreadyPaid.initialize.mock.callCount(), 0, "the last attempt had succeeded: tickets issued, no new attempt");
  assert.equal(state.order.status, "CONFIRMED");
});

test("starting payment is refused unless the order waits for payment and its payment isn't flagged; Cheche Pay failing is saved and passed on", async () => {
  arrange({ order: { status: "CONFIRMED" } });
  await assert.rejects(paymentService.startPayment(IDS.orgA, "order-1"), InvalidOrderStateError);
  mock.restoreAll();
  arrange({ payment: { status: "MISMATCH" } });
  await assert.rejects(paymentService.startPayment(IDS.orgA, "order-1"), InvalidOrderStateError);
  mock.restoreAll();
  arrange({ payment: { tx_ref: null, checkout_url: null }, keys: null });
  await assert.rejects(paymentService.startPayment(IDS.orgA, "order-1"), PaidSalesUnavailableError);
  mock.restoreAll();
  const down = arrange({ payment: { tx_ref: null, checkout_url: null } });
  down.initialize.mock.mockImplementation(async () => {
    throw new PaymentProviderUnavailableError("Cheche Pay checkout initialization failed (timed out)");
  });
  await assert.rejects(paymentService.startPayment(IDS.orgA, "order-1"), PaymentProviderUnavailableError);
  assert.equal(state.payment.last_error, "Cheche Pay checkout initialization failed (timed out)");
  assert.equal(state.payment.checkout_url, null);
});

test("merchant-verify SUCCEEDED for exactly the order issues every ticket once with one SMS; the same tx_ref again changes nothing", async () => {
  const { issue, verify, resolve } = arrange();
  const first = await paymentService.settle(TX_REF);
  assert.deepEqual([first.processed, first.duplicate, first.order_status, first.provider_status], [true, false, "CONFIRMED", "SUCCEEDED"]);
  assert.equal(verify.mock.calls[0]?.arguments[0], KEYS.secretKey);
  assert.deepEqual(resolve.mock.calls[0]?.arguments, [IDS.orgA, { includeInactive: true }], "switched-off keys still verify payments already started");
  assert.deepEqual([state.payment.status, state.payment.paid_tx_ref, state.payment.provider_transaction_id], ["PAID", TX_REF, "cp-tx-1"]);
  assert.ok(state.payment.verified_at instanceof Date);
  const codes = state.tickets.map((ticket) => ticket.code);
  assert.equal(new Set(codes).size, 3);
  assert.equal(state.messages.length, 1);
  assert.deepEqual((state.messages[0]?.payload as OrderConfirmationPayload).codes, codes);

  const again = await paymentService.settle(TX_REF);
  assert.deepEqual([again.processed, again.duplicate], [false, true]);
  assert.equal(issue.mock.callCount(), 3, "issued once");
  assert.equal(state.messages.length, 1, "one SMS");
});

test("SUCCEEDED for another amount issues nothing and is kept as MISMATCH; another currency is refused", async () => {
  const { issue, cases, openCase } = arrange({ verified: { status: "SUCCEEDED", amount: "1.00", currency: "ETB" } });
  const result = await paymentService.settle(TX_REF);
  assert.deepEqual(cases.get(TX_REF), { kind: "AMOUNT_MISMATCH", amount: "1.00", currency: "ETB", orderPaymentId: PAYMENT_ID }, "a case to investigate, for what Cheche Pay verified");
  assert.equal(openCase.mock.calls[0]?.arguments[1], FAKE_TX, "inside the settling transaction");
  assert.deepEqual([result.processed, result.review_reason, state.payment.status, state.order.status], [false, "AMOUNT_MISMATCH", "MISMATCH", "PENDING_PAYMENT"]);
  assert.match(String(state.payment.last_error), /1\.00/);
  assert.equal((await paymentService.settle(TX_REF)).duplicate, true);
  assert.equal(issue.mock.callCount(), 0);
  mock.restoreAll();
  arrange({ verified: { status: "SUCCEEDED", amount: "2000", currency: "USD" } });
  await assert.rejects(paymentService.settle(TX_REF), ConflictError);
});

test("anything but SUCCEEDED, or a tx_ref Cheche Pay doesn't know, changes nothing; other systems' tx_refs are ignored; unknown payments are 404", async () => {
  const pending = arrange({ verified: { status: "PENDING" } });
  const result = await paymentService.settle(TX_REF);
  assert.deepEqual([result.processed, result.provider_status, result.order_status, state.payment.status], [false, "PENDING", "PENDING_PAYMENT", "INITIATED"]);
  assert.equal((state.payment.last_verification as { status: string }).status, "PENDING", "the answer is kept for review");
  assert.equal(pending.issue.mock.callCount(), 0);
  mock.restoreAll();

  arrange({ verified: null });
  assert.equal((await paymentService.settle(TX_REF)).provider_status, null);
  mock.restoreAll();

  const foreign = arrange();
  assert.equal((await paymentService.settle("booking-ref-123")).ignored, true);
  assert.equal(foreign.verify.mock.callCount(), 0, "nothing is asked about a tx_ref we didn't issue");
  await assert.rejects(paymentService.settle("d0000000-0000-4000-8000-000000000009-mabc123def"), NotFoundError);
  await assert.rejects(paymentService.settle(TX_REF, { expectedOrganizationId: IDS.orgB }), ConflictError, "another organizer's payment");
});

test("a second attempt that also succeeded is flagged PAID_TWICE for a refund and changes nothing else", async () => {
  const { cases } = arrange({ payment: { status: "PAID", paid_tx_ref: TX_REF, verified_at: new Date() }, order: { status: "CONFIRMED" } });
  const second = `${PAYMENT_ID}-mzzz999yyy`;
  const result = await paymentService.settle(second);
  assert.deepEqual([result.processed, result.review_reason, state.payment.paid_tx_ref], [false, "PAID_TWICE", TX_REF]);
  assert.deepEqual(cases.get(second)?.kind, "PAID_TWICE", "a refund case for the second charge, keyed by its attempt");
  assert.equal(cases.has(TX_REF), false, "the original valid charge has no case");
  assert.match(String(state.payment.last_error), /refund/);
});

test("a payment after the places were released takes them again when there's room, and is REFUND_REQUIRED when there isn't", async () => {
  arrange({ order: { status: "EXPIRED" } });
  for (const ticket of state.tickets) ticket.status = "RELEASED";
  const taken = await paymentService.settle(TX_REF);
  assert.deepEqual([taken.order_status, state.tickets.every((ticket) => ticket.status === "CONFIRMED")], ["CONFIRMED", true]);
  mock.restoreAll();

  const full = arrange({ order: { status: "EXPIRED" }, capacity: 10, otherTaken: 9 });
  for (const ticket of state.tickets) ticket.status = "RELEASED";
  const refused = await paymentService.settle(TX_REF);
  assert.deepEqual(full.cases.get(TX_REF), { kind: "REFUND_REQUIRED", amount: "2000.00", currency: "ETB", orderPaymentId: PAYMENT_ID }, "the order total is due back");
  await paymentService.settle(TX_REF);
  assert.equal(full.cases.size, 1, "the same webhook again: still one case");
  assert.deepEqual([refused.order_status, refused.review_reason, state.payment.status], ["REFUND_REQUIRED", "PAID_AFTER_RELEASE", "PAID"], "the payment is kept for follow-up");
  assert.equal(full.issue.mock.callCount(), 0, "never oversold");
  assert.equal(state.messages.length, 0);
});

function webhookBody(event: string, txRef: string): Buffer {
  return Buffer.from(JSON.stringify({ event, data: { tx_ref: txRef, amount: "2000.00" } }));
}

test("the webhook: with a webhook secret saved the signature is required; without one the body only triggers merchant-verify", async () => {
  const secret = "whsec_testsecret123";
  const signed = arrange({ keys: { ...KEYS, webhookSecret: secret } });
  const body = webhookBody("payment.succeeded", TX_REF);
  await assert.rejects(paymentService.handleWebhook({ organizationId: IDS.orgA, rawBody: body, signature: undefined }), InvalidSignatureError);
  await assert.rejects(paymentService.handleWebhook({ organizationId: IDS.orgA, rawBody: body, signature: "deadbeef" }), InvalidSignatureError);
  assert.equal(signed.verify.mock.callCount(), 0, "nothing is read before the signature passes");
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  const ok = await paymentService.handleWebhook({ organizationId: IDS.orgA, rawBody: body, signature: `sha256=${signature}` });
  assert.deepEqual([ok.event, ok.processed, ok.order_status], ["payment.succeeded", true, "CONFIRMED"]);
  mock.restoreAll();

  arrange();
  const unsigned = await paymentService.handleWebhook({ organizationId: IDS.orgA, rawBody: body, signature: undefined });
  assert.equal(unsigned.order_status, "CONFIRMED", "no secret saved: accepted, because merchant-verify decides");
});

test("the webhook ignores other events and other systems' tx_refs, refuses bad JSON and another organizer's payment", async () => {
  const { verify } = arrange();
  assert.equal((await paymentService.handleWebhook({ organizationId: IDS.orgA, rawBody: webhookBody("refund.created", TX_REF), signature: undefined })).ignored, true);
  assert.equal((await paymentService.handleWebhook({ organizationId: IDS.orgA, rawBody: webhookBody("payment.succeeded", "other-system-1"), signature: undefined })).ignored, true);
  assert.equal(verify.mock.callCount(), 0);
  await assert.rejects(paymentService.handleWebhook({ organizationId: IDS.orgA, rawBody: Buffer.from("not json"), signature: undefined }), ValidationAppError);
  await assert.rejects(paymentService.handleWebhook({ organizationId: IDS.orgA, rawBody: null, signature: undefined }), ValidationAppError);
  await assert.rejects(paymentService.handleWebhook({ organizationId: IDS.orgB, rawBody: webhookBody("payment.succeeded", TX_REF), signature: undefined }), ConflictError);
});

test("the buyer's check verifies the current attempt; an order with no attempt yet has nothing to check", async () => {
  arrange();
  assert.equal((await paymentService.checkPayment(IDS.orgA, "order-1"))?.order_status, "CONFIRMED");
  mock.restoreAll();
  const none = arrange({ payment: { tx_ref: null } });
  assert.equal(await paymentService.checkPayment(IDS.orgA, "order-1"), null);
  assert.equal(none.verify.mock.callCount(), 0);
});

test("the worker releases unpaid holds past their time", async () => {
  arrange({ order: { hold_expires_at: new Date(Date.now() - 60_000) } });
  assert.deepEqual(await paymentService.processDue(new Date()), { expired: 1 });
  assert.equal(state.order.status, "EXPIRED");
  assert.ok(state.tickets.every((ticket) => ticket.status === "RELEASED"));
});
