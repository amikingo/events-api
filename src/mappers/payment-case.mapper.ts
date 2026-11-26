import type { KeyMode, OrderPaymentRow, PaymentStatus } from "../models/order-payment.js";
import type { PaymentCaseKind, PaymentCaseResolution, PaymentCaseRow, PaymentCaseStatus } from "../models/payment-case.js";
import type { RegistrationStatus } from "../models/registration.js";
import type { OrderStatus, TicketOrderRow } from "../models/ticket-order.js";
import type { RegistrationWithDetails } from "../repositories/registration.repository.js";

/** Pure response shaping for payment cases (Phase 8 step 3): staff only, so ids and references are included. */
export type PaymentCaseDto = {
  id: string;
  event_id: string;
  order_id: string;
  kind: PaymentCaseKind;
  /** The payment attempt the case is about (null for a ticket return). */
  tx_ref: string | null;
  /** The returned ticket (TICKET_RETURN only). */
  registration_id: string | null;
  amount: string;
  currency: string;
  status: PaymentCaseStatus;
  resolution: { outcome: PaymentCaseResolution; refunded_amount: string | null; refunded_currency: string | null; merchant_reference: string | null; note: string | null; resolved_by: string; resolved_at: Date } | null;
  created_by: string | null;
  created_at: Date;
};

export function toPaymentCaseDto(row: PaymentCaseRow): PaymentCaseDto {
  return {
    id: row.id,
    event_id: row.event_id,
    order_id: row.order_id,
    kind: row.kind,
    tx_ref: row.tx_ref,
    registration_id: row.registration_id,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    resolution:
      row.status === "RESOLVED" && row.resolution !== null && row.resolved_by !== null && row.resolved_at !== null
        ? {
            outcome: row.resolution,
            refunded_amount: row.refunded_amount,
            refunded_currency: row.refunded_currency,
            merchant_reference: row.merchant_reference,
            note: row.note,
            resolved_by: row.resolved_by,
            resolved_at: row.resolved_at,
          }
        : null,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

type TicketSummary = { id: string; code: string | null; status: RegistrationStatus; ticket_type: { code: string; name: string }; price: { amount: string; currency: string } };

/** One case with what staff need to investigate it: the order, its tickets, the payment and the returned ticket. */
export type PaymentCaseDetailDto = PaymentCaseDto & {
  order: { id: string; reference: string; status: OrderStatus; buyer_mobile: string | null; total_amount: string; currency: string; created_at: Date; tickets: TicketSummary[] };
  payment: {
    id: string;
    status: PaymentStatus;
    amount: string;
    currency: string;
    current_tx_ref: string | null;
    paid_tx_ref: string | null;
    provider_transaction_id: string | null;
    key_mode: KeyMode | null;
    verified_at: Date | null;
    last_verification: Record<string, unknown> | null;
    last_error: string | null;
  } | null;
  ticket: TicketSummary | null;
};

function toTicketSummary(row: RegistrationWithDetails): TicketSummary {
  return { id: row.id, code: row.code, status: row.status, ticket_type: { code: row.ticketType.code, name: row.ticketType.name }, price: { amount: row.price_amount, currency: row.currency } };
}

export function toPaymentCaseDetailDto(row: PaymentCaseRow, order: TicketOrderRow, tickets: RegistrationWithDetails[], payment: OrderPaymentRow | null): PaymentCaseDetailDto {
  const returned = row.registration_id === null ? null : (tickets.find((ticket) => ticket.id === row.registration_id) ?? null);
  return {
    ...toPaymentCaseDto(row),
    order: {
      id: order.id,
      reference: order.reference,
      status: order.status,
      buyer_mobile: order.buyer_mobile,
      total_amount: order.total_amount,
      currency: order.currency,
      created_at: order.created_at,
      tickets: tickets.map(toTicketSummary),
    },
    payment: payment
      ? {
          id: payment.id,
          status: payment.status,
          amount: payment.amount,
          currency: payment.currency,
          current_tx_ref: payment.tx_ref,
          paid_tx_ref: payment.paid_tx_ref,
          provider_transaction_id: payment.provider_transaction_id,
          key_mode: payment.key_mode,
          verified_at: payment.verified_at,
          last_verification: payment.last_verification,
          last_error: payment.last_error,
        }
      : null,
    ticket: returned ? toTicketSummary(returned) : null,
  };
}
