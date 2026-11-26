import type { Transaction } from "sequelize";
import { chechePayClient } from "../clients/cheche-pay.client.js";
import { paymentConfig } from "../config/payment.js";
import {
  CapacityReachedError,
  ConflictError,
  InvalidOrderStateError,
  InvalidSignatureError,
  NotFoundError,
  PaidSalesUnavailableError,
  PaymentProviderUnavailableError,
  PurchaseLimitReachedError,
  ValidationAppError,
} from "../errors/app-errors.js";
import type { OrderPaymentRow } from "../models/order-payment.js";
import type { TicketOrderRow } from "../models/ticket-order.js";
import type { TicketTypeRow } from "../models/ticket-type.js";
import { eventRepository } from "../repositories/event.repository.js";
import { orderPaymentRepository } from "../repositories/order-payment.repository.js";
import { registrationRepository } from "../repositories/registration.repository.js";
import { ticketOrderRepository } from "../repositories/ticket-order.repository.js";
import { ticketTypeRepository } from "../repositories/ticket-type.repository.js";
import { logger } from "../utils/logger.js";
import { MONEY_PATTERN, normalizeAmount } from "../utils/money.js";
import { chechePayCredentialService } from "./cheche-pay-credential.service.js";
import { paymentCaseService } from "./payment-case.service.js";
import { ensureFound, runTransaction } from "./helpers.js";
import { ticketing } from "./ticketing.js";

/**
 * Paid orders through Cheche Pay v2 (Phase 7 step 3b), following bookings_api's integration:
 * - **The receiving business** is the organizer's own Cheche Pay secret key (saved by the Super Admin): the buyer
 *   never chooses where the money goes, and there is no platform key.
 * - **Starting:** after checkout commits, transactions/initialize with the organizer's key and a fresh tx_ref
 *   (`<payment id>-<suffix>`: v2 refuses a reused one). An unexpired checkout link is reused. Never inside a database
 *   transaction.
 * - **Settling:** webhooks and the buyer's return are only triggers. The payment's state always comes from
 *   merchant-verify with the organizer's key (settle): SUCCEEDED for exactly the stored amount in ETB issues the
 *   tickets; another amount is kept as MISMATCH and issues nothing; the same tx_ref again changes nothing; a second
 *   attempt that also succeeded is flagged PAID_TWICE for a refund; anything else changes nothing (the hold lapses on
 *   its own deadline).
 * - **The webhook** is checked against the organizer's webhook secret when one is saved (401 otherwise), as bookings.
 * - **Issuing** runs under the event lock, then the order and payment locks: held tickets become CONFIRMED with codes
 *   and one SMS lists them.
 * - **Release:** an unpaid hold past hold_expires_at gives its places and purchase allowance back (EXPIRED).
 * - **A late payment** (after its places were released) takes them again when the event, ticket types and buyer's
 *   limit still allow; otherwise the order becomes REFUND_REQUIRED with its payment kept for follow-up. It never
 *   oversells.
 */

const SUCCEEDED = "SUCCEEDED";

/** The order and its payment, both locked, under the event lock (the lock order every place change uses). */
async function lockOrder(organizationId: string, orderId: string, transaction: Transaction): Promise<{ order: TicketOrderRow; payment: OrderPaymentRow }> {
  const found = ensureFound(await ticketOrderRepository.findByOrganizationAndId(organizationId, orderId, { transaction }), "Order not found");
  const event = ensureFound(await eventRepository.findByOrganizationAndId(organizationId, found.event_id, { transaction, lock: true }), "Event not found");
  // A lapsed hold (this order's or another's) is released first, so what follows decides on the real state.
  await ticketing.releaseExpiredHolds(event, new Date(), transaction);
  const order = ensureFound(await ticketOrderRepository.findByOrganizationAndId(organizationId, orderId, { transaction, lock: true }), "Order not found");
  const payment = ensureFound(await orderPaymentRepository.findByOrder(organizationId, orderId, { transaction, lock: true }), "Payment not found");
  return { order, payment };
}

/** Issues the order's held (or released) tickets: each gets its code; one SMS lists them. */
async function issueTickets(order: TicketOrderRow, transaction: Transaction): Promise<void> {
  const event = ensureFound(await eventRepository.findByOrganizationAndId(order.organization_id, order.event_id, { transaction }), "Event not found");
  const tickets = (await registrationRepository.listByOrder(order.organization_id, order.event_id, order.id, { transaction })).filter(
    (ticket) => ticket.status === "HELD" || ticket.status === "RELEASED",
  );
  const codes: string[] = [];
  for (const ticket of tickets) {
    const code = await ticketing.newCode(transaction);
    await registrationRepository.issueHeld(order.organization_id, order.event_id, ticket.id, code, { transaction });
    codes.push(code);
  }
  await ticketOrderRepository.updateById(order.organization_id, order.id, { status: "CONFIRMED" }, { transaction });
  await ticketing.queueOrderConfirmation(event, order, codes, transaction);
}

/** A late payment: the released places again, if the event, the ticket types and the buyer's limit still allow. */
async function placesStillFree(order: TicketOrderRow, transaction: Transaction): Promise<boolean> {
  const event = ensureFound(await eventRepository.findByOrganizationAndId(order.organization_id, order.event_id, { transaction }), "Event not found");
  const released = (await registrationRepository.listByOrder(order.organization_id, order.event_id, order.id, { transaction })).filter((ticket) => ticket.status === "RELEASED");
  const perType = new Map<string, number>();
  for (const ticket of released) perType.set(ticket.ticket_type_id, (perType.get(ticket.ticket_type_id) ?? 0) + 1);
  const demand: Array<{ ticketType: TicketTypeRow; quantity: number }> = [];
  for (const id of [...perType.keys()].sort()) {
    const ticketType = ensureFound(await ticketTypeRepository.findByEventAndId(order.organization_id, order.event_id, id, { transaction, lock: true }), "Ticket type not found");
    demand.push({ ticketType, quantity: perType.get(id) as number });
  }
  try {
    await ticketing.assertRoom(event, demand, transaction);
    await ticketing.assertBuyerAllowance(event, order.buyer_mobile, released.length, transaction);
    return true;
  } catch (error) {
    if (error instanceof CapacityReachedError || error instanceof PurchaseLimitReachedError) return false;
    throw error;
  }
}

export type SettleResult = {
  acknowledged: true;
  /** The payment was applied now (tickets issued, or the order marked REFUND_REQUIRED). */
  processed: boolean;
  /** This tx_ref had already been applied (or already kept as MISMATCH); nothing changed. */
  duplicate: boolean;
  /** Not ours (another integration on the same Cheche Pay business, or not a payment event): nothing read. */
  ignored: boolean;
  review_reason: "AMOUNT_MISMATCH" | "PAID_AFTER_RELEASE" | "PAID_TWICE" | null;
  /** What merchant-verify said (SUCCEEDED, PENDING, FAILED…); null when Cheche Pay doesn't know the tx_ref. */
  provider_status: string | null;
  order_status: TicketOrderRow["status"] | null;
};

const IGNORED: SettleResult = { acknowledged: true, processed: false, duplicate: false, ignored: true, review_reason: null, provider_status: null, order_status: null };

/** Cheche Pay's amount as an exact two-place string ("2000" → "2000.00"). */
function verifiedAmount(value: string | number | null): string {
  const text = value === null ? "" : String(value).trim();
  if (!MONEY_PATTERN.test(text)) throw new ConflictError("Cheche Pay reported an invalid amount", { amount: value });
  return normalizeAmount(text);
}

/**
 * Verifies one tx_ref with merchant-verify (before any transaction) and applies the answer. Safe to repeat. The
 * organizer's key is used even if switched off since, so payments already started can still be confirmed.
 */
async function settle(txRef: string, options: { expectedOrganizationId?: string } = {}): Promise<SettleResult> {
  const paymentId = chechePayClient.parseTxRef(txRef);
  if (paymentId === null) return IGNORED;
  const found = ensureFound(await orderPaymentRepository.findById(paymentId), "Payment not found");
  if (options.expectedOrganizationId !== undefined && found.organization_id !== options.expectedOrganizationId) {
    throw new ConflictError("This payment belongs to another organizer");
  }
  const keys = await chechePayCredentialService.resolve(found.organization_id, { includeInactive: true });
  if (!keys) throw new PaidSalesUnavailableError("This organizer has no Cheche Pay keys to verify the payment", { reason: "NO_CHECHE_PAY_KEYS" });
  const verified = await chechePayClient.verify(keys.secretKey, txRef);
  const providerStatus = verified?.status ?? null;
  const checked = { tx_ref: txRef, status: providerStatus, amount: verified?.amount ?? null, currency: verified?.currency ?? null, checked_at: new Date().toISOString() };

  if (verified === null || providerStatus !== SUCCEEDED) {
    // Pending, failed, declined or unknown: nothing to apply. The hold lapses on its own deadline.
    await orderPaymentRepository.updateById(found.id, { last_verification: checked });
    const order = await ticketOrderRepository.findByOrganizationAndId(found.organization_id, found.order_id);
    return { acknowledged: true, processed: false, duplicate: false, ignored: false, review_reason: null, provider_status: providerStatus, order_status: order?.status ?? null };
  }
  if (verified.currency !== null && verified.currency !== "ETB") {
    throw new ConflictError("Cheche Pay reported an unexpected currency", { currency: verified.currency });
  }
  const amount = verifiedAmount(verified.amount);

  return runTransaction(async (transaction) => {
    const { order, payment } = await lockOrder(found.organization_id, found.order_id, transaction);
    const result = (processed: boolean, duplicate: boolean, review: SettleResult["review_reason"], status: TicketOrderRow["status"]): SettleResult => ({
      acknowledged: true,
      processed,
      duplicate,
      ignored: false,
      review_reason: review,
      provider_status: providerStatus,
      order_status: status,
    });
    await orderPaymentRepository.updateById(payment.id, { last_verification: checked, provider_transaction_id: verified.transactionId ?? payment.provider_transaction_id }, { transaction });

    const openCase = (kind: "REFUND_REQUIRED" | "PAID_TWICE" | "AMOUNT_MISMATCH", caseAmount: string) =>
      paymentCaseService.openForAttempt(
        { organizationId: order.organization_id, eventId: order.event_id, orderId: order.id, orderPaymentId: payment.id, kind, txRef, amount: caseAmount, currency: payment.currency },
        transaction,
      );

    if (normalizeAmount(payment.amount) !== amount) {
      // A success for another amount is kept for staff, never applied; Phase 8: a case to investigate (once per attempt).
      if (payment.status !== "PAID") {
        await orderPaymentRepository.updateById(payment.id, { status: "MISMATCH", last_error: `Cheche Pay verified ${amount} for ${txRef}; the order expects ${payment.amount}` }, { transaction });
      }
      await openCase("AMOUNT_MISMATCH", amount);
      logger.warn({ orderId: order.id, paymentId: payment.id }, "Cheche Pay verified a payment for another amount: nothing issued");
      return result(false, payment.status === "MISMATCH", "AMOUNT_MISMATCH", order.status);
    }

    if (payment.status === "PAID") {
      if (payment.paid_tx_ref === txRef) {
        // A duplicate. A late payment's case exists already; opening is idempotent (one case per attempt).
        if (order.status === "REFUND_REQUIRED") await openCase("REFUND_REQUIRED", payment.amount);
        return result(false, true, order.status === "REFUND_REQUIRED" ? "PAID_AFTER_RELEASE" : null, order.status);
      }
      // Two attempts both succeeded: the buyer paid twice. Kept for a refund; answered 200 so Cheche Pay stops retrying.
      await orderPaymentRepository.updateById(payment.id, { last_error: `A second Cheche Pay attempt (${txRef}) also succeeded: refund one of them` }, { transaction });
      await openCase("PAID_TWICE", amount);
      logger.warn({ orderId: order.id, paymentId: payment.id }, "A second Cheche Pay attempt also succeeded: refund required for one");
      return result(false, false, "PAID_TWICE", order.status);
    }

    await orderPaymentRepository.updateById(payment.id, { status: "PAID", paid_tx_ref: txRef, verified_at: new Date(), last_error: null }, { transaction });
    if (order.status === "PENDING_PAYMENT") {
      await issueTickets(order, transaction);
      return result(true, false, null, "CONFIRMED");
    }
    if (order.status === "EXPIRED" && (await placesStillFree(order, transaction))) {
      await issueTickets(order, transaction);
      return result(true, false, null, "CONFIRMED");
    }
    await ticketOrderRepository.updateById(order.organization_id, order.id, { status: "REFUND_REQUIRED" }, { transaction });
    await openCase("REFUND_REQUIRED", payment.amount);
    logger.warn({ orderId: order.id, paymentId: payment.id }, "Paid after its places were released and no room is left: refund required");
    return result(true, false, "PAID_AFTER_RELEASE", "REFUND_REQUIRED");
  });
}

function returnUrlFor(order: TicketOrderRow): string | null {
  return paymentConfig.returnUrl === null ? null : `${paymentConfig.returnUrl}/orders/${order.reference}`;
}

function callbackUrlFor(organizationId: string): string | null {
  return paymentConfig.publicApiBaseUrl === null ? null : `${paymentConfig.publicApiBaseUrl}/v1/payments/cheche/webhook/${organizationId}`;
}

/**
 * Sends the buyer to pay: an unexpired checkout link is reused; otherwise the last attempt is verified first (so a
 * buyer who already paid isn't charged twice), then a new attempt is initialized with a fresh tx_ref and the
 * organizer's active key. Refused unless the order is waiting for payment and its payment hasn't been flagged.
 */
async function startPayment(organizationId: string, orderId: string): Promise<OrderPaymentRow> {
  const order = ensureFound(await ticketOrderRepository.findByOrganizationAndId(organizationId, orderId), "Order not found");
  if (order.status !== "PENDING_PAYMENT") throw new InvalidOrderStateError(undefined, { status: order.status });
  let payment = ensureFound(await orderPaymentRepository.findByOrder(organizationId, orderId), "Payment not found");
  if (payment.status !== "INITIATED") throw new InvalidOrderStateError("This order's payment is waiting for review", { status: order.status, payment_status: payment.status });
  const now = new Date();
  if (payment.checkout_url !== null && (payment.checkout_expires_at === null || payment.checkout_expires_at > now)) return payment;

  if (payment.tx_ref !== null) {
    const previous = await settle(payment.tx_ref, { expectedOrganizationId: organizationId });
    if (previous.processed || previous.review_reason !== null) return ensureFound(await orderPaymentRepository.findByOrder(organizationId, orderId), "Payment not found");
    payment = ensureFound(await orderPaymentRepository.findByOrder(organizationId, orderId), "Payment not found");
  }

  const keys = await chechePayCredentialService.requireForSale(organizationId);
  const txRef = chechePayClient.newTxRef(payment.id);
  const returnUrl = returnUrlFor(order);
  const callbackUrl = callbackUrlFor(organizationId);
  const phoneNumber = order.buyer_mobile as string;
  // What is sent, for review; never the key.
  const request = { amount: payment.amount, tx_ref: txRef, currency: "ETB", phone_number: phoneNumber, return_url: returnUrl, callback_url: callbackUrl };
  await orderPaymentRepository.updateById(payment.id, { tx_ref: txRef, key_mode: keys.mode, checkout_url: null, checkout_expires_at: null, request_object: request });
  try {
    const result = await chechePayClient.initialize({ secretKey: keys.secretKey, amount: payment.amount, txRef, phoneNumber, returnUrl, callbackUrl });
    await orderPaymentRepository.updateById(payment.id, {
      checkout_url: result.checkoutUrl,
      checkout_expires_at: result.expiresAt,
      provider_transaction_id: result.transactionId,
      response_object: result.raw,
      last_error: null,
    });
  } catch (error) {
    if (error instanceof PaymentProviderUnavailableError) await orderPaymentRepository.updateById(payment.id, { last_error: error.message });
    throw error;
  }
  return ensureFound(await orderPaymentRepository.findByOrder(organizationId, orderId), "Payment not found");
}

/** After checkout commits: starts a paid order's payment; a Cheche Pay problem leaves the order pending (logged). */
async function startPaymentIfPending(organizationId: string, orderId: string): Promise<void> {
  const order = await ticketOrderRepository.findByOrganizationAndId(organizationId, orderId);
  if (order?.status !== "PENDING_PAYMENT") return;
  try {
    await startPayment(organizationId, orderId);
  } catch (error) {
    logger.warn({ orderId, err: error instanceof Error ? { name: error.name, message: error.message } : error }, "Couldn't start the Cheche Pay payment yet; the buyer can retry");
  }
}

/** The buyer is back from Cheche Pay (or asks again): verifies the current attempt, if there is one. */
async function checkPayment(organizationId: string, orderId: string): Promise<SettleResult | null> {
  const payment = await orderPaymentRepository.findByOrder(organizationId, orderId);
  if (!payment || payment.tx_ref === null) return null;
  return settle(payment.tx_ref, { expectedOrganizationId: organizationId });
}

/**
 * Cheche Pay's webhook for one organizer (the id is in the callback address), as bookings. When the organizer's
 * webhook secret is saved, X-Cheche-Signature must be the HMAC of the raw body (401 otherwise). The body only names
 * the tx_ref; settle asks merchant-verify for its state. Other events and other systems' tx_refs are acknowledged.
 */
async function handleWebhook(input: { organizationId: string; rawBody: Buffer | null; signature: string | undefined }): Promise<SettleResult & { event: string | null }> {
  if (input.rawBody === null) throw new ValidationAppError("The webhook body is missing");
  const keys = await chechePayCredentialService.resolve(input.organizationId, { includeInactive: true });
  if (keys !== null && keys.webhookSecret !== null && !chechePayClient.verifySignature(input.rawBody, input.signature, keys.webhookSecret)) {
    throw new InvalidSignatureError();
  }
  let body: unknown;
  try {
    body = JSON.parse(input.rawBody.toString("utf8"));
  } catch {
    throw new ValidationAppError("The webhook body is not valid JSON");
  }
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const event = typeof record.event === "string" ? record.event : null;
  const data = typeof record.data === "object" && record.data !== null ? (record.data as Record<string, unknown>) : {};
  const txRef = typeof data.tx_ref === "string" ? data.tx_ref.trim() : "";
  if (event?.startsWith("payment.") !== true || txRef === "" || chechePayClient.parseTxRef(txRef) === null) return { ...IGNORED, event };
  try {
    return { ...(await settle(txRef, { expectedOrganizationId: input.organizationId })), event };
  } catch (error) {
    if (error instanceof NotFoundError) logger.warn({ organizationId: input.organizationId }, "Cheche Pay webhook for a payment we don't have");
    throw error;
  }
}

/** An unpaid order past its hold: the places and the allowance go back. */
async function expireOrder(organizationId: string, orderId: string, now: Date): Promise<boolean> {
  return runTransaction(async (transaction) => {
    const found = ensureFound(await ticketOrderRepository.findByOrganizationAndId(organizationId, orderId, { transaction }), "Order not found");
    ensureFound(await eventRepository.findByOrganizationAndId(organizationId, found.event_id, { transaction, lock: true }), "Event not found");
    const order = ensureFound(await ticketOrderRepository.findByOrganizationAndId(organizationId, orderId, { transaction, lock: true }), "Order not found");
    if (order.status !== "PENDING_PAYMENT" || order.hold_expires_at === null || order.hold_expires_at > now) return false;
    await registrationRepository.releaseHeldByOrder(organizationId, order.event_id, order.id, { transaction });
    await ticketOrderRepository.updateById(organizationId, order.id, { status: "EXPIRED" }, { transaction });
    return true;
  });
}

/** One tick of the payment worker: unpaid holds past their time give their places back. */
async function processDue(now: Date = new Date()): Promise<{ expired: number }> {
  let expired = 0;
  for (const order of await ticketOrderRepository.listExpiredPending(now, paymentConfig.worker.batchSize)) {
    if (await expireOrder(order.organization_id, order.id, now)) expired += 1;
  }
  return { expired };
}

export const paymentService = {
  settle,
  startPayment,
  startPaymentIfPending,
  checkPayment,
  handleWebhook,
  processDue,
};
