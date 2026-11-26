import type { OrderSource, OrderStatus, TicketOrderRow } from "../models/ticket-order.js";
import type { RegistrationStatus } from "../models/registration.js";
import type { PublicEventRow } from "../repositories/event.repository.js";
import type { RegistrationWithDetails } from "../repositories/registration.repository.js";
import type { ConfirmationDto } from "./registration.mapper.js";

/**
 * Pure response shaping for orders (Phase 7). Staff see the order with ids, the buyer and each ticket's holder; a
 * visitor sees their reference, total and codes, never internal ids or audit fields.
 */
export type OrderTicketDto = {
  id: string;
  code: string;
  status: RegistrationStatus;
  ticket_type: { id: string; code: string; name: string };
  price: { amount: string; currency: string };
  /** null for an unnamed QUICK ticket. */
  holder: { person_id: string; first_name: string; last_name: string | null; phone: string | null; email: string | null; affiliation_name: string | null } | null;
};

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
  ticket_count: number;
  tickets: OrderTicketDto[];
  /** The order confirmation SMS to the buyer: PENDING, SENT, FAILED or SKIPPED; null when none was queued. */
  confirmation: ConfirmationDto;
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

export function toOrderDto(order: TicketOrderRow, tickets: RegistrationWithDetails[], confirmation: ConfirmationDto = null): OrderDto {
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
    ticket_count: tickets.length,
    tickets: tickets.map(toOrderTicketDto),
    confirmation,
    created_by: order.created_by,
    created_at: order.created_at,
  };
}

/** A staff list row: the order without its tickets. */
export type OrderSummaryDto = Omit<OrderDto, "tickets" | "confirmation" | "ticket_count">;

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
    created_by: order.created_by,
    created_at: order.created_at,
  };
}

/** What a visitor sees after checkout: their reference, the total and every code. */
export type PublicOrderDto = {
  reference: string;
  status: OrderStatus;
  total_amount: string;
  currency: string;
  created_at: Date;
  event: { name: string; slug: string; starts_at: Date | null; ends_at: Date | null; timezone: string };
  organization: { name: string; slug: string };
  tickets: Array<{
    code: string;
    status: RegistrationStatus;
    ticket_type: { code: string; name: string };
    price: { amount: string; currency: string };
    holder: { first_name: string; last_name: string | null } | null;
  }>;
};

export function toPublicOrderDto(order: TicketOrderRow, tickets: RegistrationWithDetails[], event: PublicEventRow): PublicOrderDto {
  return {
    reference: order.reference,
    status: order.status,
    total_amount: order.total_amount,
    currency: order.currency,
    created_at: order.created_at,
    event: { name: event.name, slug: event.slug, starts_at: event.starts_at, ends_at: event.ends_at, timezone: event.timezone },
    organization: { name: event.organization.name, slug: event.organization.slug },
    tickets: tickets.map((row) => ({
      code: row.code,
      status: row.status,
      ticket_type: { code: row.ticketType.code, name: row.ticketType.name },
      price: { amount: row.price_amount, currency: row.currency },
      holder: row.person ? { first_name: row.person.first_name, last_name: row.person.last_name } : null,
    })),
  };
}
