import { z } from "zod";
import type { RequestContract } from "../middleware/validate.js";
import { mobileSchema } from "./auth.js";
import {
  codeSchema,
  contactEmailSchema,
  contactPhoneSchema,
  countryCodeSchema,
  idempotencyKeySchema,
  nullableText,
  paginationQuerySchema,
  uuidSchema,
} from "./common.js";
import { eventParamsSchema } from "./event.js";
import { publicEventParamsSchema } from "./public-event.js";

/**
 * Checkout (Phase 7): one buyer gets several tickets, of one or more ticket types, in one order.
 * - `items`: each ticket type once, with a whole quantity (at most 20 tickets per order in total; the service checks).
 * - `holders`: for a DETAILED event, one entry per ticket of the item, with the details the event collects (the
 *   service applies its required and hidden fields). A QUICK event takes none: its tickets are unnamed.
 * - `buyer_mobile`: the Ethiopian mobile the codes are sent to, stored as +251…; what the purchase limit counts by.
 *   On the public form it is required unless the buyer is signed in (then the account's verified mobile is used).
 * Prices are never sent: the server resolves them from the ticket types.
 * A paid order (Phase 7 step 3b) needs nothing more: the organizer's Cheche Pay keys decide where the money goes.
 */
export const holderSchema = z.strictObject({
  first_name: z.string().trim().min(1).max(100).optional(),
  last_name: nullableText(100),
  phone: contactPhoneSchema,
  email: contactEmailSchema,
  affiliation_name: nullableText(200),
  country: countryCodeSchema.nullable().optional(),
});

const quantitySchema = z.number().int().min(1).max(20);
const holdersSchema = z.array(holderSchema).min(1).max(20).optional();

function eachTicketTypeOnce<T>(key: (item: T) => string) {
  return (items: T[], ctx: z.RefinementCtx) => {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      if (seen.has(key(item))) ctx.addIssue({ code: "custom", path: [index], message: "Each ticket type may appear only once; raise its quantity instead" });
      seen.add(key(item));
    });
  };
}

const publicItemSchema = z.strictObject({ ticket_type_code: codeSchema, quantity: quantitySchema, holders: holdersSchema });
const staffItemSchema = z.strictObject({ ticket_type_id: uuidSchema, quantity: quantitySchema, holders: holdersSchema });

export const publicOrderSchema = z.strictObject({
  buyer_mobile: mobileSchema.optional(),
  /** The privacy notice the form showed (from the event page). */
  privacy_notice_version: z.string().trim().min(1).max(40),
  items: z
    .array(publicItemSchema)
    .min(1)
    .max(10)
    .superRefine(eachTicketTypeOnce((item) => item.ticket_type_code)),
});

export const staffOrderSchema = z.strictObject({
  buyer_mobile: mobileSchema.optional(),
  items: z
    .array(staffItemSchema)
    .min(1)
    .max(10)
    .superRefine(eachTicketTypeOnce((item) => item.ticket_type_id)),
});

export const orderParamsSchema = eventParamsSchema.extend({ orderId: uuidSchema });

/** `buyer_mobile` narrows the list to one buyer (any Ethiopian format). */
export const orderListQuerySchema = paginationQuerySchema.extend({ buyer_mobile: mobileSchema.optional() });

export type HolderInput = z.output<typeof holderSchema>;
export type PublicOrderInput = z.output<typeof publicOrderSchema>;
export type StaffOrderInput = z.output<typeof staffOrderSchema>;
export type OrderListQuery = z.output<typeof orderListQuerySchema>;

/** Required on the public form: the same key with the same order returns the original order and codes. */
export const publicOrderHeadersSchema = z.object({ "idempotency-key": idempotencyKeySchema });
/** Optional for staff, as for single registrations. */
export const staffOrderHeadersSchema = z.object({ "idempotency-key": idempotencyKeySchema.optional() });

// One contract per endpoint (see middleware/validate.ts).
export const createPublicOrderRequest = { params: publicEventParamsSchema, headers: publicOrderHeadersSchema, body: publicOrderSchema } satisfies RequestContract;

export const createStaffOrderRequest = { params: eventParamsSchema, headers: staffOrderHeadersSchema, body: staffOrderSchema } satisfies RequestContract;

export const listOrdersRequest = { params: eventParamsSchema, query: orderListQuerySchema } satisfies RequestContract;

export const getOrderRequest = { params: orderParamsSchema } satisfies RequestContract;
