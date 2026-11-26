import type { OrderPaymentRow, PaymentStatus } from "../models/order-payment.js";
import type { OrderSource, OrderStatus, TicketOrderRow } from "../models/ticket-order.js";
import type { RegistrationStatus } from "../models/registration.js";
import type { RegistrationWithDetails } from "../repositories/registration.repository.js";
import type { ConfirmationDto } from "./registration.mapper.js";

/**
 * Pure response shaping for orders (Phase 7). Staff see the order with ids, the buyer, each ticket's holder and the
 * payment; a visitor sees their reference, total, payment link and codes, never internal ids or audit fields.
 * A ticket's code is null while its order waits for payment (HELD) or after an unpaid hold ended (RELEASED).
 * `order_token` appears only in the reply that created (or replayed) the order: only its hash is stored.
 */
export type OrderTicketDto = {
  id: string;
  code: string | null;
  status: RegistrationStatus;
  ticket_type: { id: string; code: string; name: string };
  price: { amount: string; currency: string };
  /** null for an unnamed QUICK ticket. */
  holder: { person_id: string; first_name: string; last_name: string | null; phone: string | null; email: string | null; affiliation_name: string | null } | null;
};

/** A paid order's Cheche Pay payment: where the buyer pays, and what Cheche Pay reported. null for a free order. */
export type OrderPaymentDto = {
  id: string;
  status: PaymentStatus;
  payment_option_id: string;
  checkout_url: string | null;
  vendor_ref: string | null;
  notify_time: Date | null;
  last_error: string | null;
} | null;

export type OrderDto = {
  id: string;
  event_id: string;
  reference: string;
  status: OrderStatus;
  source: OrderSource;
  buyer_mobile: string | null;
  /** Whether a signed-in Cheche account bought it (it then appears in that account's My Tickets). */
  bought_with_account: boolean;
  total_amount: string;
  currency: string;
  /** When a PENDING_PAYMENT order's held places are released if unpaid. */
  hold_expires_at: Date | null;
  payment: OrderPaymentDto;
  ticket_count: number;
  tickets: OrderTicketDto[];
  /** The order confirmation SMS to the buyer: PENDING, SENT, FAILED or SKIPPED; null when none was queued. */
  confirmation: ConfirmationDto;
  /** Only when the order was just created or replayed: the buyer's key to read it without an account. */
  order_token?: string;
  created_by: string | null;
  created_at: Date;
};

function toOrderTicketDto(row: RegistrationWithDetails): OrderTicketDto {
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    ticket_type: { id: row.ticketType.id, code: row.ticketType.code, name: row.ticketType.name },
    price: { amount: row.price_amount, currency: row.currency },
    holder: row.person
      ? {
          person_id: row.person.id,
          first_name: row.person.first_name,
          last_name: row.person.last_name,
          phone: row.person.phone,
          email: row.person.email,
          affiliation_name: row.person.affiliation_name,
        }
      : null,
  };
}

function toOrderPaymentDto(payment: OrderPaymentRow | null): OrderPaymentDto {
  return payment
    ? {
        id: payment.id,
        status: payment.status,
        payment_option_id: payment.payment_option_id,
        checkout_url: payment.checkout_url,
        vendor_ref: payment.vendor_ref,
        notify_time: payment.notify_time,
        last_error: payment.last_error,
      }
    : null;
}

export function toOrderDto(
  order: TicketOrderRow,
  tickets: RegistrationWithDetails[],
  confirmation: ConfirmationDto = null,
  payment: OrderPaymentRow | null = null,
  orderToken: string | null = null,
): OrderDto {
  return {
    id: order.id,
    event_id: order.event_id,
    reference: order.reference,
    status: order.status,
    source: order.source,
    buyer_mobile: order.buyer_mobile,
    bought_with_account: order.buyer_user_id !== null,
    total_amount: order.total_amount,
    currency: order.currency,
    hold_expires_at: order.hold_expires_at,
    payment: toOrderPaymentDto(payment),
    ticket_count: tickets.length,
    tickets: tickets.map(toOrderTicketDto),
    confirmation,
    ...(orderToken === null ? {} : { order_token: orderToken }),
    created_by: order.created_by,
    created_at: order.created_at,
  };
}

/** A staff list row: the order without its tickets or payment. */
export type OrderSummaryDto = Omit<OrderDto, "tickets" | "confirmation" | "ticket_count" | "payment" | "order_token">;

export function toOrderSummaryDto(order: TicketOrderRow): OrderSummaryDto {
  return {
    id: order.id,
    event_id: order.event_id,
    reference: order.reference,
    status: order.status,
    source: order.source,
    buyer_mobile: order.buyer_mobile,
    bought_with_account: order.buyer_user_id !== null,
    total_amount: order.total_amount,
    currency: order.currency,
    hold_expires_at: order.hold_expires_at,
    created_by: order.created_by,
    created_at: order.created_at,
  };
}

/** The event and organizer a visitor sees with their order. */
export type PublicOrderContext = {
  event: { name: string; slug: string; starts_at: Date | null; ends_at: Date | null; timezone: string };
  organization: { name: string; slug: string };
};

/** What a visitor sees after checkout and on their order page: reference, total, payment link and every code. */
export type PublicOrderDto = {
  reference: string;
  status: OrderStatus;
  total_amount: string;
  currency: string;
  hold_expires_at: Date | null;
  payment: { status: PaymentStatus; checkout_url: string | null } | null;
  created_at: Date;
  event: PublicOrderContext["event"];
  organization: PublicOrderContext["organization"];
  tickets: Array<{
    code: string | null;
    status: RegistrationStatus;
    ticket_type: { code: string; name: string };
    price: { amount: string; currency: string };
    holder: { first_name: string; last_name: string | null } | null;
  }>;
  /** Only in the reply that created (or replayed) the order: keep it to open the order page later. */
  order_token?: string;
};

export function toPublicOrderDto(
  order: TicketOrderRow,
  tickets: RegistrationWithDetails[],
  context: PublicOrderContext,
  payment: OrderPaymentRow | null = null,
  orderToken: string | null = null,
): PublicOrderDto {
  return {
    reference: order.reference,
    status: order.status,
    total_amount: order.total_amount,
    currency: order.currency,
    hold_expires_at: order.hold_expires_at,
    payment: payment ? { status: payment.status, checkout_url: payment.checkout_url } : null,
    created_at: order.created_at,
    event: context.event,
    organization: context.organization,
    tickets: tickets.map((row) => ({
      code: row.code,
      status: row.status,
      ticket_type: { code: row.ticketType.code, name: row.ticketType.name },
      price: { amount: row.price_amount, currency: row.currency },
      holder: row.person ? { first_name: row.person.first_name, last_name: row.person.last_name } : null,
    })),
    ...(orderToken === null ? {} : { order_token: orderToken }),
  };
}
