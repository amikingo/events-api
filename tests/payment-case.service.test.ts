import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import type { Transaction } from "sequelize";
import { NotFoundError, PaymentCaseAlreadyResolvedError } from "../src/errors/app-errors.js";
import type { PaymentCaseRow } from "../src/models/payment-case.js";
import { orderPaymentRepository } from "../src/repositories/order-payment.repository.js";
import { paymentCaseRepository } from "../src/repositories/payment-case.repository.js";
import { registrationRepository } from "../src/repositories/registration.repository.js";
import { ticketOrderRepository } from "../src/repositories/ticket-order.repository.js";
import { transactionManager } from "../src/services/helpers.js";
import { paymentCaseService } from "../src/services/payment-case.service.js";
import { IDS, orderPaymentRow, orderRow, orderSummary, PAYMENT_ID, registrationRow, ticketTypeRow, TX_REF } from "./helpers/fixtures.js";

/** Payment cases (Phase 8 step 3) against an in-memory table: one case per issue, resolutions, repeats. */
const FAKE_TX = { id: "fake-transaction" } as unknown as Transaction;
let table: PaymentCaseRow[];

function caseRow(overrides: Partial<PaymentCaseRow> = {}): PaymentCaseRow {
  return {
    id: "case-1",
    organization_id: IDS.orgA,
    event_id: IDS.event,
    order_id: "order-1",
    order_payment_id: PAYMENT_ID,
    registration_id: null,
    kind: "PAID_TWICE",
    tx_ref: TX_REF,
    amount: "2000.00",
    currency: "ETB",
    status: "OPEN",
    resolution: null,
    refunded_amount: null,
    refunded_currency: null,
    merchant_reference: null,
    note: null,
    resolved_by: null,
    resolved_at: null,
    created_by: null,
    created_at: new Date("2026-11-27T08:00:00Z"),
    updated_at: new Date("2026-11-27T08:00:00Z"),
    ...overrides,
  };
}

function arrange(rows: PaymentCaseRow[] = [], options: { raceOnce?: boolean } = {}) {
  table = rows.map((row) => ({ ...row }));
  let raced = options.raceOnce === true;
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
  mock.method(paymentCaseRepository, "findByAttempt", async (organizationId: string, txRef: string) => table.find((row) => row.organization_id === organizationId && row.tx_ref === txRef && row.kind !== "TICKET_RETURN") ?? null);
  mock.method(paymentCaseRepository, "findByReturn", async (organizationId: string, registrationId: string) => table.find((row) => row.organization_id === organizationId && row.registration_id === registrationId) ?? null);
  mock.method(paymentCaseRepository, "findByOrganizationAndId", async (organizationId: string, id: string) => {
    const row = table.find((entry) => entry.organization_id === organizationId && entry.id === id);
    return row ? { ...row } : null;
  });
  const create = mock.method(paymentCaseRepository, "createUnlessTaken", async (values: Partial<PaymentCaseRow>) => {
    const row = caseRow({ id: `case-${table.length + 1}`, registration_id: null, tx_ref: null, ...values });
    table.push(row);
    if (raced) {
      // Another transaction opened the same case first: the insert lost, the existing one is read.
      raced = false;
      return null;
    }
    return row;
  });
  const resolve = mock.method(paymentCaseRepository, "resolveById", async (_o: string, id: string, values: Partial<PaymentCaseRow>) => {
    Object.assign(table.find((row) => row.id === id) as PaymentCaseRow, values);
  });
  mock.method(ticketOrderRepository, "findByOrganizationAndId", async () => orderRow({ id: "order-1", status: "CONFIRMED", total_amount: "2000.00" }));
  mock.method(registrationRepository, "listByOrder", async () => [
    { ...registrationRow({ id: "ticket-1", code: "K7M2Q9XP" }), person: null, ticketType: ticketTypeRow(), order: orderSummary() },
  ]);
  mock.method(orderPaymentRepository, "findByOrder", async () => orderPaymentRow({ status: "PAID", paid_tx_ref: TX_REF }));
  return { create, resolve };
}

afterEach(() => mock.restoreAll());

const attempt = { organizationId: IDS.orgA, eventId: IDS.event, orderId: "order-1", orderPaymentId: PAYMENT_ID, kind: "PAID_TWICE" as const, txRef: TX_REF, amount: "2000.00", currency: "ETB" };

test("a payment attempt opens one case, inside the caller's transaction; the same attempt again, or a lost race, returns that case", async () => {
  const { create } = arrange();
  const first = await paymentCaseService.openForAttempt(attempt, FAKE_TX);
  const again = await paymentCaseService.openForAttempt(attempt, FAKE_TX);
  assert.equal(first.id, again.id);
  assert.equal(create.mock.callCount(), 1);
  assert.equal(create.mock.calls[0]?.arguments[1]?.transaction, FAKE_TX);
  mock.restoreAll();

  arrange([], { raceOnce: true });
  const raced = await paymentCaseService.openForAttempt(attempt, FAKE_TX);
  assert.equal(raced.tx_ref, TX_REF, "the case the other transaction opened");
});

test("a returned paid ticket opens one TICKET_RETURN case for its stored price; two tickets of one order are two cases", async () => {
  const { create } = arrange();
  const input = { organizationId: IDS.orgA, eventId: IDS.event, orderId: "order-1", orderPaymentId: PAYMENT_ID, registrationId: "ticket-vip", amount: "1000.00", currency: "ETB", actorId: IDS.user };
  const first = await paymentCaseService.openForReturn(input, FAKE_TX);
  await paymentCaseService.openForReturn(input, FAKE_TX);
  await paymentCaseService.openForReturn({ ...input, registrationId: "ticket-ga", amount: "500.00" }, FAKE_TX);
  assert.deepEqual([first.kind, first.registration_id, first.amount, first.created_by], ["TICKET_RETURN", "ticket-vip", "1000.00", IDS.user]);
  assert.equal(create.mock.callCount(), 2);
});

test("resolving as REFUNDED records the amount, currency, merchant reference, staff member and time; the same again changes nothing; another outcome is 409", async () => {
  const { resolve } = arrange([caseRow()]);
  const refund = { resolution: "REFUNDED" as const, refunded_amount: "2000.00", refunded_currency: "ETB", merchant_reference: "CP-REFUND-77" };
  const done = await paymentCaseService.resolve(IDS.orgA, "case-1", refund, IDS.user);
  assert.deepEqual([done.status, done.resolution?.outcome, done.resolution?.refunded_amount, done.resolution?.merchant_reference, done.resolution?.resolved_by], ["RESOLVED", "REFUNDED", "2000.00", "CP-REFUND-77", IDS.user]);
  assert.ok(done.resolution?.resolved_at instanceof Date);
  assert.deepEqual([done.order.reference, done.payment?.paid_tx_ref, done.order.tickets[0]?.code], [orderRow().reference, TX_REF, "K7M2Q9XP"], "the order and payment attempt to check against");

  const repeated = await paymentCaseService.resolve(IDS.orgA, "case-1", refund, IDS.user);
  assert.equal(repeated.resolution?.resolved_at.getTime(), done.resolution?.resolved_at.getTime());
  assert.equal(resolve.mock.callCount(), 1, "a repeated staff action has one effect");
  await assert.rejects(paymentCaseService.resolve(IDS.orgA, "case-1", { ...refund, merchant_reference: "OTHER" }, IDS.user), PaymentCaseAlreadyResolvedError);
  await assert.rejects(paymentCaseService.resolve(IDS.orgA, "case-1", { resolution: "CLOSED_WITHOUT_REFUND", note: "Buyer declined" }, IDS.user), PaymentCaseAlreadyResolvedError);
});

test("a mismatch can be closed without a refund, with a note; another organization's case is not found", async () => {
  arrange([caseRow({ kind: "AMOUNT_MISMATCH", amount: "1.00" })]);
  const closed = await paymentCaseService.resolve(IDS.orgA, "case-1", { resolution: "CLOSED_WITHOUT_REFUND", note: "Test payment by the organizer" }, IDS.user);
  assert.deepEqual([closed.resolution?.outcome, closed.resolution?.note, closed.resolution?.refunded_amount], ["CLOSED_WITHOUT_REFUND", "Test payment by the organizer", null]);
  await assert.rejects(paymentCaseService.get(IDS.orgB, "case-1"), NotFoundError);
  await assert.rejects(paymentCaseService.resolve(IDS.orgB, "case-1", { resolution: "CLOSED_WITHOUT_REFUND", note: "x" }, IDS.user), NotFoundError);
});
