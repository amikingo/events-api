import type { Transaction } from "sequelize";
import { chechePayClient, type PaymentOption } from "../clients/cheche-pay.client.js";
import {
  CapacityReachedError,
  ConflictError,
  InvalidOrderStateError,
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
import { organizationRepository } from "../repositories/organization.repository.js";
import { registrationRepository } from "../repositories/registration.repository.js";
import { ticketOrderRepository } from "../repositories/ticket-order.repository.js";
import { ticketTypeRepository } from "../repositories/ticket-type.repository.js";
import { logger } from "../utils/logger.js";
import { normalizeAmount } from "../utils/money.js";
import type { ChechePayNotificationInput } from "../validators/payment.js";
import { ensureFound, runTransaction } from "./helpers.js";
import { ticketing } from "./ticketing.js";

/**
 * Paid orders through Cheche Pay (Phase 7 step 3), following bookings_api's integration:
 * - **The receiving merchant** is the organizer's Cheche Pay service code (set by the Super Admin). The buyer picks
 *   one of that code's payment options; the server refuses any other option, so the money can't go elsewhere.
 * - **Starting:** after checkout commits, createOrder with our payment row id as `transaction_id` (the same id on
 *   every retry). Never inside a database transaction.
 * - **The callback** (notify-from-chechepay, POST or GET), handled exactly as bookings does: it isn't signed, and the
 *   legacy API has no status check, so a callback is trusted on our payment id, the exact amount and a "Completed"
 *   status. A "Completed" callback for another amount is kept as MISMATCH and issues nothing; a repeat with the same
 *   Cheche Pay reference changes nothing; a different reference, or a non-completed status after payment, is refused
 *   (409); any other status is acknowledged and changes nothing (the hold lapses on its own).
 * - **Issuing** runs under the event lock, then the order and payment locks: held tickets become CONFIRMED with codes
 *   and one SMS lists them.
 * - **Release:** an unpaid hold past hold_expires_at gives its places and purchase allowance back (EXPIRED).
 * - **A late payment** (after its places were released) takes them again when the event, ticket types and buyer's
 *   limit still allow; otherwise the order becomes REFUND_REQUIRED with its payment kept for follow-up. It never
 *   oversells.
 * Known risk (as in bookings): anyone who learns a payment id and its amount could fake a "Completed" callback, until
 * Cheche Pay offers a status check or signed callbacks.
 */

/** Cheche Pay's "Completed" spellings, as bookings reads them. */
function normalizeTradeStatus(value: string): string {
  return ["completed", "success", "successful", "paid"].includes(value.trim().toLowerCase()) ? "Completed" : value.trim();
}

/** The payment option the buyer chose, checked against the organizer's service code (before any transaction). */
async function resolvePaymentOption(organizationId: string, paymentOptionId: string): Promise<{ optionId: string; serviceCode: string }> {
  const organization = ensureFound(await organizationRepository.findById(organizationId), "Organization not found");
  if (organization.cheche_pay_service === null) throw new PaidSalesUnavailableError(undefined, { reason: "NO_CHECHE_PAY_SERVICE" });
  const options = await chechePayClient.listPaymentOptions(organization.cheche_pay_service);
  if (!options.some((option) => option.id === paymentOptionId)) {
    throw new ValidationAppError("Request validation failed", {
      issues: [{ path: "body.payment_option_id", message: "Choose one of this organizer's payment options", code: "unknown_payment_option" }],
    });
  }
  return { optionId: paymentOptionId, serviceCode: organization.cheche_pay_service };
}

/** The organizer's payment options for the public event page ([] when paid sales are off). */
async function listOptionsForOrganization(organizationId: string): Promise<Array<{ id: string; name: string | null }>> {
  const organization = ensureFound(await organizationRepository.findById(organizationId), "Organization not found");
  if (organization.cheche_pay_service === null) return [];
  return (await chechePayClient.listPaymentOptions(organization.cheche_pay_service)).map((option) => ({ id: option.id, name: option.name }));
}

export type ChechePaySettingDto = {
  cheche_pay_service: string | null;
  payment_options: Array<{ id: string; name: string | null }>;
  paid_sales_available: boolean;
  warnings: Array<{ code: string; message: string }>;
};

function settingDto(code: string | null, options: PaymentOption[] | null, warnings: ChechePaySettingDto["warnings"] = []): ChechePaySettingDto {
  return {
    cheche_pay_service: code,
    payment_options: (options ?? []).map((option) => ({ id: option.id, name: option.name })),
    paid_sales_available: code !== null && (options?.length ?? 0) > 0,
    warnings,
  };
}

async function optionsOrNull(code: string): Promise<PaymentOption[] | null> {
  try {
    return await chechePayClient.listPaymentOptions(code);
  } catch {
    return null;
  }
}

/** Platform scope: the organizer's service code and what Cheche Pay offers for it. */
async function getChechePaySetting(organizationId: string): Promise<ChechePaySettingDto> {
  const organization = ensureFound(await organizationRepository.findById(organizationId), "Organization not found");
  if (organization.cheche_pay_service === null) return settingDto(null, null);
  const options = await optionsOrNull(organization.cheche_pay_service);
  return settingDto(organization.cheche_pay_service, options, options === null ? [{ code: "CHECHE_PAY_UNREACHABLE", message: "Cheche Pay couldn't be reached to list the payment options" }] : []);
}

/**
 * Platform scope: sets the code (upper-case) or clears it (paid sales off). As bookings, an unknown code is still
 * saved (Cheche Pay may register it later) with a warning; Cheche Pay is asked before the transaction.
 */
async function setChechePayService(organizationId: string, code: string | null, actorId: string | null): Promise<ChechePaySettingDto> {
  const options = code === null ? null : await optionsOrNull(code);
  const warnings: ChechePaySettingDto["warnings"] = [];
  if (code !== null && !options?.length) {
    warnings.push({
      code: "CHECHE_PAY_SERVICE_HAS_NO_OPTIONS",
      message: `Saved, but Cheche Pay has no payment options for "${code}" yet. Paid sales stay off for this organizer until it has.`,
    });
  }
  await runTransaction(async (transaction) => {
    ensureFound(await organizationRepository.findById(organizationId, { transaction, lock: true }), "Organization not found");
    await organizationRepository.updateSettings(organizationId, { cheche_pay_service: code, updated_by: actorId }, { transaction });
  });
  return settingDto(code, options, warnings);
}

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

/**
 * Sends the buyer to pay: createOrder with the payment's id (the same id on every retry), the chosen option, the
 * amount and the buyer's mobile; saves the checkout URL. Refused unless the order is waiting for payment.
 */
async function startPayment(organizationId: string, orderId: string): Promise<OrderPaymentRow> {
  const order = ensureFound(await ticketOrderRepository.findByOrganizationAndId(organizationId, orderId), "Order not found");
  if (order.status !== "PENDING_PAYMENT") throw new InvalidOrderStateError(undefined, { status: order.status });
  const payment = ensureFound(await orderPaymentRepository.findByOrder(organizationId, orderId), "Payment not found");
  if (payment.checkout_url !== null) return payment;
  const event = ensureFound(await eventRepository.findByOrganizationAndId(organizationId, order.event_id), "Event not found");
  const request = {
    paymentOption_id: payment.payment_option_id,
    title: event.name.slice(0, 120),
    paymentType: "C2B" as const,
    transaction_id: payment.id,
    user_id: order.buyer_user_id,
    amount: payment.amount,
    phone_number: order.buyer_mobile as string,
  };
  await orderPaymentRepository.updateById(payment.id, { request_object: request });
  try {
    const result = await chechePayClient.createOrder({
      paymentOptionId: request.paymentOption_id,
      title: request.title,
      paymentType: request.paymentType,
      transactionId: request.transaction_id,
      userId: request.user_id,
      amount: request.amount,
      phoneNumber: request.phone_number,
    });
    await orderPaymentRepository.updateById(payment.id, { checkout_url: result.url, provider_order_id: result.providerOrderId, response_object: result.raw, last_error: null });
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

export type NotificationResult = {
  acknowledged: true;
  processed: boolean;
  duplicate: boolean;
  review_reason: "AMOUNT_MISMATCH" | "PAID_AFTER_RELEASE" | null;
  order_status: TicketOrderRow["status"];
};

/** Finds the payment a callback is about: by our transaction id, or (as bookings) by Cheche Pay's own order id. */
async function paymentForNotification(notification: ChechePayNotificationInput): Promise<OrderPaymentRow> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let payment = notification.transactionId && uuid.test(notification.transactionId) ? await orderPaymentRepository.findById(notification.transactionId.toLowerCase()) : null;
  const amountOf = (row: OrderPaymentRow | null) => row !== null && normalizeAmount(row.amount) === notification.amount;
  if ((!payment || !amountOf(payment)) && notification.vendorRef) {
    const byProviderOrder = await orderPaymentRepository.findByProviderOrderId(notification.vendorRef);
    if (byProviderOrder && amountOf(byProviderOrder)) payment = byProviderOrder;
  }
  return ensureFound(payment, "Payment not found");
}

/** Cheche Pay's callback (notify-from-chechepay), handled exactly as bookings handles it. Safe to repeat. */
async function handleNotification(notification: ChechePayNotificationInput): Promise<NotificationResult> {
  const tradeStatus = normalizeTradeStatus(notification.tradeStatus);
  const found = await paymentForNotification(notification);
  const amountMatches = normalizeAmount(found.amount) === notification.amount;
  if (!amountMatches && tradeStatus !== "Completed") throw new ConflictError("Callback amount does not match the stored payment");

  return runTransaction(async (transaction) => {
    const { order, payment } = await lockOrder(found.organization_id, found.order_id, transaction);
    const received = { ...notification.raw, received_at: new Date().toISOString() };
    await orderPaymentRepository.updateById(payment.id, { last_notification: received }, { transaction });
    const result = (processed: boolean, duplicate: boolean, review: NotificationResult["review_reason"], status: TicketOrderRow["status"]): NotificationResult => ({
      acknowledged: true,
      processed,
      duplicate,
      review_reason: review,
      order_status: status,
    });

    if (!amountMatches) {
      // A success report for another amount is kept for staff, never applied.
      if (payment.status !== "PAID") {
        await orderPaymentRepository.updateById(payment.id, { status: "MISMATCH", last_error: `Cheche Pay reported ${notification.amount}; the order expects ${payment.amount}` }, { transaction });
      }
      logger.warn({ orderId: order.id, paymentId: payment.id }, "Cheche Pay reported a payment for another amount: nothing issued");
      return result(false, payment.status === "MISMATCH", "AMOUNT_MISMATCH", order.status);
    }

    if (payment.status === "PAID") {
      if (payment.vendor_ref !== notification.vendorRef) throw new ConflictError("Callback vendor reference does not match the stored payment");
      if (tradeStatus !== "Completed") throw new ConflictError("Contradictory payment notification");
      return result(false, true, order.status === "REFUND_REQUIRED" ? "PAID_AFTER_RELEASE" : null, order.status);
    }

    // Anything but "Completed": acknowledged, nothing changes (the hold lapses on its own deadline).
    if (tradeStatus !== "Completed") return result(false, false, null, order.status);
    if (payment.vendor_ref !== null && payment.vendor_ref !== notification.vendorRef) {
      throw new ConflictError("Callback vendor reference does not match the stored payment");
    }

    await orderPaymentRepository.updateById(payment.id, { status: "PAID", vendor_ref: notification.vendorRef, notify_time: new Date(), last_error: null }, { transaction });
    if (order.status === "PENDING_PAYMENT") {
      await issueTickets(order, transaction);
      return result(true, false, null, "CONFIRMED");
    }
    if (order.status === "EXPIRED" && (await placesStillFree(order, transaction))) {
      await issueTickets(order, transaction);
      return result(true, false, null, "CONFIRMED");
    }
    await ticketOrderRepository.updateById(order.organization_id, order.id, { status: "REFUND_REQUIRED" }, { transaction });
    logger.warn({ orderId: order.id, paymentId: payment.id }, "Paid after its places were released and no room is left: refund required");
    return result(true, false, "PAID_AFTER_RELEASE", "REFUND_REQUIRED");
  });
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
  for (const order of await ticketOrderRepository.listExpiredPending(now, 20)) {
    if (await expireOrder(order.organization_id, order.id, now)) expired += 1;
  }
  return { expired };
}

export const paymentService = {
  resolvePaymentOption,
  listOptionsForOrganization,
  getChechePaySetting,
  setChechePayService,
  startPayment,
  startPaymentIfPending,
  handleNotification,
  processDue,
};
