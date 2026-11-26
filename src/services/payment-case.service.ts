import type { Transaction } from "sequelize";
import { PaymentCaseAlreadyResolvedError } from "../errors/app-errors.js";
import { toPaymentCaseDetailDto, toPaymentCaseDto, type PaymentCaseDetailDto, type PaymentCaseDto } from "../mappers/payment-case.mapper.js";
import type { PaymentCaseKind, PaymentCaseRow } from "../models/payment-case.js";
import { orderPaymentRepository } from "../repositories/order-payment.repository.js";
import { paymentCaseRepository } from "../repositories/payment-case.repository.js";
import { registrationRepository } from "../repositories/registration.repository.js";
import { ticketOrderRepository } from "../repositories/ticket-order.repository.js";
import { normalizeAmount } from "../utils/money.js";
import { buildPagination } from "../utils/pagination.js";
import type { PaymentCaseListQuery, PaymentCaseResolveInput } from "../validators/payment-case.js";
import { ensureFound, runTransaction } from "./helpers.js";

/**
 * Payment cases (Phase 8 step 3): money issues staff resolve by hand through the organizer's own Cheche Pay merchant
 * account. Refunds are manual; the API records what was done.
 * - Opened inside the transaction that finds the issue (paymentService.settle for REFUND_REQUIRED, PAID_TWICE and
 *   AMOUNT_MISMATCH; the ticket return for TICKET_RETURN). One case per payment attempt (tx_ref) or returned ticket,
 *   so a repeated webhook, check or return has one effect.
 * - Resolving records the outcome, the staff member and the time, and never touches tickets or orders: closing a
 *   double charge keeps the tickets of the original valid charge. Resolving again with the same outcome is a no-op.
 */

export type AttemptCaseInput = {
  organizationId: string;
  eventId: string;
  orderId: string;
  orderPaymentId: string;
  kind: Exclude<PaymentCaseKind, "TICKET_RETURN">;
  txRef: string;
  amount: string;
  currency: string;
};

export type ReturnCaseInput = {
  organizationId: string;
  eventId: string;
  orderId: string;
  orderPaymentId: string | null;
  registrationId: string;
  amount: string;
  currency: string;
  actorId: string | null;
};

/** The case of a payment attempt, opened once (inside the caller's transaction). */
async function openForAttempt(input: AttemptCaseInput, transaction: Transaction): Promise<PaymentCaseRow> {
  const existing = await paymentCaseRepository.findByAttempt(input.organizationId, input.txRef, { transaction });
  if (existing) return existing;
  const created = await paymentCaseRepository.createUnlessTaken(
    {
      organization_id: input.organizationId,
      event_id: input.eventId,
      order_id: input.orderId,
      order_payment_id: input.orderPaymentId,
      kind: input.kind,
      tx_ref: input.txRef,
      amount: input.amount,
      currency: input.currency,
    },
    { transaction },
  );
  return created ?? ensureFound(await paymentCaseRepository.findByAttempt(input.organizationId, input.txRef, { transaction }), "Payment case not found");
}

/** The refund due on a returned paid ticket, opened once (inside the return's transaction). */
async function openForReturn(input: ReturnCaseInput, transaction: Transaction): Promise<PaymentCaseRow> {
  const existing = await paymentCaseRepository.findByReturn(input.organizationId, input.registrationId, { transaction });
  if (existing) return existing;
  const created = await paymentCaseRepository.createUnlessTaken(
    {
      organization_id: input.organizationId,
      event_id: input.eventId,
      order_id: input.orderId,
      order_payment_id: input.orderPaymentId,
      registration_id: input.registrationId,
      kind: "TICKET_RETURN",
      amount: input.amount,
      currency: input.currency,
      created_by: input.actorId,
    },
    { transaction },
  );
  return created ?? ensureFound(await paymentCaseRepository.findByReturn(input.organizationId, input.registrationId, { transaction }), "Payment case not found");
}

/** A ticket's return case, if it has one (read under the caller's locks). */
async function findReturnCase(organizationId: string, registrationId: string, transaction: Transaction): Promise<PaymentCaseRow | null> {
  return paymentCaseRepository.findByReturn(organizationId, registrationId, { transaction });
}

async function list(organizationId: string, query: PaymentCaseListQuery): Promise<{ rows: PaymentCaseDto[]; count: number }> {
  const { limit, offset } = buildPagination(query);
  const { rows, count } = await paymentCaseRepository.listByOrganization(organizationId, { status: query.status, kind: query.kind, eventId: query.event_id, limit, offset });
  return { rows: rows.map(toPaymentCaseDto), count };
}

async function detail(organizationId: string, row: PaymentCaseRow): Promise<PaymentCaseDetailDto> {
  const order = ensureFound(await ticketOrderRepository.findByOrganizationAndId(organizationId, row.order_id), "Order not found");
  const tickets = await registrationRepository.listByOrder(organizationId, order.event_id, order.id);
  const payment = await orderPaymentRepository.findByOrder(organizationId, order.id);
  return toPaymentCaseDetailDto(row, order, tickets, payment);
}

async function get(organizationId: string, caseId: string): Promise<PaymentCaseDetailDto> {
  return detail(organizationId, ensureFound(await paymentCaseRepository.findByOrganizationAndId(organizationId, caseId), "Payment case not found"));
}

/** Whether a resolved case already holds exactly this outcome (so a repeated staff action changes nothing). */
function sameOutcome(row: PaymentCaseRow, input: PaymentCaseResolveInput): boolean {
  if (row.resolution !== input.resolution) return false;
  if (input.resolution === "REFUNDED") {
    return (
      row.refunded_amount !== null &&
      normalizeAmount(row.refunded_amount) === input.refunded_amount &&
      row.refunded_currency === input.refunded_currency &&
      row.merchant_reference === input.merchant_reference
    );
  }
  return row.note === (input.note ?? null);
}

/** Records the outcome after staff moved any money by hand; the case row is locked while it's decided. */
async function resolve(organizationId: string, caseId: string, input: PaymentCaseResolveInput, actorId: string): Promise<PaymentCaseDetailDto> {
  const row = await runTransaction(async (transaction) => {
    const current = ensureFound(await paymentCaseRepository.findByOrganizationAndId(organizationId, caseId, { transaction, lock: true }), "Payment case not found");
    if (current.status === "RESOLVED") {
      if (sameOutcome(current, input)) return current;
      throw new PaymentCaseAlreadyResolvedError(undefined, { resolution: current.resolution, resolved_at: current.resolved_at });
    }
    await paymentCaseRepository.resolveById(
      organizationId,
      caseId,
      {
        status: "RESOLVED",
        resolution: input.resolution,
        refunded_amount: input.resolution === "REFUNDED" ? (input.refunded_amount ?? null) : null,
        refunded_currency: input.resolution === "REFUNDED" ? (input.refunded_currency ?? null) : null,
        merchant_reference: input.resolution === "REFUNDED" ? (input.merchant_reference ?? null) : null,
        note: input.note ?? null,
        resolved_by: actorId,
        resolved_at: new Date(),
      },
      { transaction },
    );
    return ensureFound(await paymentCaseRepository.findByOrganizationAndId(organizationId, caseId, { transaction }), "Payment case not found");
  });
  return detail(organizationId, row);
}

export const paymentCaseService = { openForAttempt, openForReturn, findReturnCase, list, get, resolve };
