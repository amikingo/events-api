import type { Transaction } from "sequelize";
import { EventHasAdmissionsError, InvalidEventStateError, ValidationAppError } from "../errors/app-errors.js";
import type { EventRow } from "../models/event.js";
import type { EventCancelledPayload, EventRescheduledPayload } from "../models/message-outbox.js";
import type { TicketOrderRow } from "../models/ticket-order.js";
import { eventRepository } from "../repositories/event.repository.js";
import { messageOutboxRepository } from "../repositories/message-outbox.repository.js";
import { orderPaymentRepository } from "../repositories/order-payment.repository.js";
import { organizationRepository } from "../repositories/organization.repository.js";
import { registrationRepository } from "../repositories/registration.repository.js";
import { ticketAdmissionRepository } from "../repositories/ticket-admission.repository.js";
import { ticketOrderRepository } from "../repositories/ticket-order.repository.js";
import { logger } from "../utils/logger.js";
import { isZeroAmount, sumAmounts } from "../utils/money.js";
import { ensureFound, runTransaction } from "./helpers.js";
import { paymentCaseService } from "./payment-case.service.js";

/**
 * What happens to buyers when an organizer changes an event that already has sales or admissions (Phase 9). Every
 * change locks the event row FOR UPDATE first, the order every place change uses, so a gate scan (event key share),
 * a payment, a return or another edit resolves before or after it, never in between.
 *
 * Cancelling (one action, also after the first admission):
 * - unpaid holds are released once (tickets RELEASED, orders EXPIRED): their seats and buyer allowance come back;
 * - every confirmed, unused ticket is cancelled, which invalidates its code and gives back one event seat, one place of
 *   its type and one unit of allowance, exactly once (each ticket changes status once);
 * - admitted tickets keep their admission and charge; the organizer decides once whether used paid tickets are
 *   refunded too (refund_admitted_tickets, required only when guests were admitted), stored on the event;
 * - each paid order gets one EVENT_CANCELLATION case for what is due (its unused paid tickets' checkout prices, plus
 *   the used ones when approved), keyed by the charge that paid it: a repeated cancellation opens nothing new;
 * - one SMS per affected order with a buyer mobile (held ones included), naming the refund due;
 * - totals, admissions and cases already recorded stay as they are. A payment arriving later is handled by
 *   paymentService.settle (refund case, no seats).
 *
 * Rescheduling (a previously published event, before its first admission): starts_at and ends_at are saved together,
 * an explicit door time is confirmed again, tickets, codes, prices, payments and holds stay; one SMS per order with
 * issued tickets for each actual change.
 */

export type CancelInput = { refundAdmittedTickets?: boolean | undefined };

function decisionRequired(): ValidationAppError {
  return new ValidationAppError("Request validation failed", {
    issues: [
      {
        path: "body.refund_admitted_tickets",
        message: "Guests were already admitted: say whether their used paid tickets are refunded too",
        code: "refund_decision_required",
      },
    ],
  });
}

async function organizationName(organizationId: string, transaction: Transaction): Promise<string> {
  return ensureFound(await organizationRepository.findById(organizationId, { transaction }), "Organization not found").name;
}

/** Cancels the event and settles what its buyers are owed. An already cancelled event is returned as it is. */
async function cancel(organizationId: string, eventId: string, input: CancelInput, actorId: string | null): Promise<EventRow> {
  return runTransaction(async (transaction) => {
    const event = ensureFound(await eventRepository.findByOrganizationAndId(organizationId, eventId, { transaction, lock: true }), "Event not found");
    if (event.status === "CANCELLED") return event;
    if (event.status !== "DRAFT" && event.status !== "PUBLISHED") {
      throw new InvalidEventStateError(`An event can't go from ${event.status} to CANCELLED`, { from: event.status, to: "CANCELLED" });
    }
    const admissions = await ticketAdmissionRepository.countByEvent(organizationId, eventId, { transaction });
    if (admissions > 0 && input.refundAdmittedTickets === undefined) throw decisionRequired();
    const refundAdmitted = admissions > 0 ? (input.refundAdmittedTickets as boolean) : false;

    // 1. Unpaid holds: released once, with their seats and allowance.
    const pending = await ticketOrderRepository.listPendingByEvent(organizationId, eventId, { transaction });
    for (const order of pending) {
      await registrationRepository.releaseHeldByOrder(organizationId, eventId, order.id, { transaction });
      await ticketOrderRepository.updateById(organizationId, order.id, { status: "EXPIRED" }, { transaction });
    }

    // 2. Issued tickets: unused ones are cancelled; admitted ones keep their admission.
    const tickets = await registrationRepository.listConfirmedWithAdmission(organizationId, eventId, { transaction });
    await registrationRepository.cancelByIds(
      organizationId,
      eventId,
      tickets.filter((ticket) => !ticket.admitted).map((ticket) => ticket.id),
      actorId,
      { transaction },
    );

    // 3. What each order is owed: unused paid tickets at their checkout price, plus used ones when approved.
    const dueByOrder = new Map<string, string[]>();
    for (const ticket of tickets) {
      const refundable = !ticket.admitted || refundAdmitted;
      const amounts = dueByOrder.get(ticket.order_id) ?? [];
      if (refundable && !isZeroAmount(ticket.price_amount)) amounts.push(ticket.price_amount);
      dueByOrder.set(ticket.order_id, amounts);
    }
    const issuedOrders = await ticketOrderRepository.listByEventAndIds(organizationId, eventId, [...dueByOrder.keys()], { transaction });
    const refunds = new Map<string, string>();
    for (const order of issuedOrders) {
      const due = sumAmounts(dueByOrder.get(order.id) ?? []);
      refunds.set(order.id, due);
      if (isZeroAmount(due)) continue;
      const payment = await orderPaymentRepository.findByOrder(organizationId, order.id, { transaction });
      if (!payment?.paid_tx_ref) {
        logger.warn({ orderId: order.id }, "A paid ticket's order has no recorded charge: no cancellation case opened");
        continue;
      }
      await paymentCaseService.openForAttempt(
        { organizationId, eventId, orderId: order.id, orderPaymentId: payment.id, kind: "EVENT_CANCELLATION", txRef: payment.paid_tx_ref, amount: due, currency: order.currency },
        transaction,
      );
    }

    // 4. One SMS per affected order with a buyer mobile, held orders included.
    const organization = await organizationName(organizationId, transaction);
    for (const order of [...issuedOrders, ...pending]) {
      await queueCancelled(event, organization, order, refunds.get(order.id) ?? "0.00", transaction);
    }

    // 5. The event itself.
    const updated = await eventRepository.updateByOrganizationAndId(
      organizationId,
      eventId,
      { status: "CANCELLED", cancelled_at: new Date(), cancelled_by: actorId, refund_admitted_tickets: admissions > 0 ? refundAdmitted : null, updated_by: actorId },
      { transaction },
    );
    return ensureFound(updated, "Event not found");
  });
}

async function queueCancelled(event: EventRow, organization: string, order: TicketOrderRow, refund: string, transaction: Transaction): Promise<void> {
  if (order.buyer_mobile === null) return;
  const payload: EventCancelledPayload = {
    organization_name: organization,
    event_name: event.name,
    starts_at: event.starts_at === null ? null : event.starts_at.toISOString(),
    timezone: event.timezone,
    refund_amount: refund,
    currency: order.currency,
  };
  await messageOutboxRepository.create(
    { organization_id: event.organization_id, registration_id: null, order_id: order.id, kind: "EVENT_CANCELLED", channel: "SMS", recipient: order.buyer_mobile, payload },
    { transaction },
  );
}

type SchedulePatch = { starts_at?: Date | null | undefined; ends_at?: Date | null | undefined; doors_open_at?: Date | null | undefined };

const sameInstant = (a: Date | null | undefined, b: Date | null | undefined): boolean => (a ?? null)?.getTime() === (b ?? null)?.getTime();
const effectiveDoors = (event: Pick<EventRow, "doors_open_at" | "starts_at">): Date | null => event.doors_open_at ?? event.starts_at;

function scheduleIssue(path: string, message: string, code: string): ValidationAppError {
  return new ValidationAppError("Request validation failed", { issues: [{ path: `body.${path}`, message, code }] });
}

/**
 * The rules for moving a previously published event (called by the event update and the reschedule action, under
 * the event's FOR UPDATE lock): starts_at and ends_at together, an explicit door time confirmed again, and no
 * admission yet. A draft that was never published moves freely; the same values again are no change.
 */
async function assertReschedulable(current: EventRow, patch: SchedulePatch, transaction: Transaction): Promise<void> {
  if (current.published_at === null) return;
  const startsChange = patch.starts_at !== undefined && !sameInstant(patch.starts_at, current.starts_at);
  const endsChange = patch.ends_at !== undefined && !sameInstant(patch.ends_at, current.ends_at);
  const doorsChange = patch.doors_open_at !== undefined && !sameInstant(patch.doors_open_at, current.doors_open_at);
  if (!startsChange && !endsChange && !doorsChange) return;
  if (startsChange || endsChange) {
    if (patch.starts_at === undefined) throw scheduleIssue("starts_at", "Send starts_at with ends_at: the schedule moves as a whole", "schedule_pair_required");
    if (patch.ends_at === undefined) throw scheduleIssue("ends_at", "Send ends_at with starts_at: the schedule moves as a whole", "schedule_pair_required");
    if (current.doors_open_at !== null && patch.doors_open_at === undefined) {
      throw scheduleIssue("doors_open_at", "The event has its own door time: send it again (the same, a new one, or null to open at the start)", "doors_open_at_reconfirm");
    }
  }
  const admissions = await ticketAdmissionRepository.countByEvent(current.organization_id, current.id, { transaction });
  if (admissions > 0) throw new EventHasAdmissionsError(undefined, { admissions });
}

/**
 * After a previously published event's schedule was saved: one SMS per order with issued tickets and a buyer mobile,
 * only when the start, the end or the effective door time actually changed (retrying the same values sends nothing).
 */
async function notifyRescheduled(before: EventRow, after: EventRow, transaction: Transaction): Promise<number> {
  if (before.published_at === null || after.starts_at === null) return 0;
  const changed = !sameInstant(before.starts_at, after.starts_at) || !sameInstant(before.ends_at, after.ends_at) || !sameInstant(effectiveDoors(before), effectiveDoors(after));
  if (!changed) return 0;
  const orderIds = await registrationRepository.listOrderIdsWithConfirmed(after.organization_id, after.id, { transaction });
  const orders = await ticketOrderRepository.listByEventAndIds(after.organization_id, after.id, orderIds, { transaction });
  const organization = await organizationName(after.organization_id, transaction);
  const doors = effectiveDoors(after);
  const payload: EventRescheduledPayload = {
    organization_name: organization,
    event_name: after.name,
    starts_at: after.starts_at.toISOString(),
    doors_open_at: doors !== null && !sameInstant(doors, after.starts_at) ? doors.toISOString() : null,
    timezone: after.timezone,
  };
  let queued = 0;
  for (const order of orders) {
    if (order.buyer_mobile === null) continue;
    await messageOutboxRepository.create(
      { organization_id: after.organization_id, registration_id: null, order_id: order.id, kind: "EVENT_RESCHEDULED", channel: "SMS", recipient: order.buyer_mobile, payload },
      { transaction },
    );
    queued += 1;
  }
  return queued;
}

export const eventChangeService = { cancel, assertReschedulable, notifyRescheduled };
