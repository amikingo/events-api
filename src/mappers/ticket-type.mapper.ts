import type { TicketTypeRow } from "../models/ticket-type.js";
import type { TicketTypePriceWindowRow } from "../models/ticket-type-price-window.js";
import { isZeroAmount } from "../utils/money.js";
import { effectivePrice } from "../utils/ticket-pricing.js";

export type PriceWindowDto = { id: string; starts_at: Date; ends_at: Date | null; price: string };

/**
 * A ticket type for staff (Phase 11). `price` stays the editable regular price; `price_windows` is the schedule;
 * `effective_price` / `effective_is_free` are what a new order would pay right now and `price_valid_until` when that
 * changes (null: it doesn't). All amounts are in the ticket type's `currency`.
 */
export type TicketTypeDto = TicketTypeRow & {
  price_windows: PriceWindowDto[];
  effective_price: string;
  effective_is_free: boolean;
  price_valid_until: Date | null;
};

export function toTicketTypeDto(ticketType: TicketTypeRow, windows: readonly TicketTypePriceWindowRow[], now: Date): TicketTypeDto {
  const sorted = [...windows].sort((a, b) => a.starts_at.getTime() - b.starts_at.getTime());
  const quote = effectivePrice(ticketType.price, sorted, now);
  return {
    ...ticketType,
    price_windows: sorted.map((window) => ({ id: window.id, starts_at: window.starts_at, ends_at: window.ends_at, price: window.price })),
    effective_price: quote.price,
    effective_is_free: isZeroAmount(quote.price),
    price_valid_until: quote.valid_until,
  };
}
