import { z } from "zod";
import type { RequestContract } from "../middleware/validate.js";
import type { TicketAudience } from "../models/ticket-type.js";
import { codeSchema, dateTimeSchema, moneyAmountSchema, statusChangeSchema, uuidSchema } from "./common.js";
import { eventParamsSchema } from "./event.js";

/** Optional separate limit for this category; null means it draws only on the event's overall limit. */
const capacitySchema = z.number().int().positive().max(1_000_000).nullable().optional();
const displayOrderSchema = z.number().int().min(0).max(10_000);
/** Phase 7: "0" is free (the default); more is paid, in the organizer's currency (copied, never sent). */
const priceSchema = moneyAmountSchema;
/** Phase 7: PUBLIC (default) or STAFF_ONLY (only authorized staff may issue it). */
const audienceSchema = z.enum(["PUBLIC", "STAFF_ONLY"] as const satisfies readonly TicketAudience[]);

/**
 * Phase 11: one-off scheduled prices. Inside a window a new order pays its exact price; outside every window the
 * regular `price`. starts_at is included, ends_at excluded; leaving ends_at out means until the schedule changes.
 * Instants need an offset or Z. Up to 20 windows. Ranges and overlaps are checked by the service (issue codes
 * invalid_range and overlapping_window): two open-ended windows overlap, adjacent ones are fine.
 */
const priceWindowSchema = z.strictObject({
  starts_at: dateTimeSchema,
  ends_at: dateTimeSchema.nullable().optional(),
  price: priceSchema,
});
const priceWindowsSchema = z.array(priceWindowSchema).max(20);

export const ticketTypeCreateSchema = z.strictObject({
  /** Unique within the event, stored upper-case (e.g. "vip" → "VIP"). */
  code: codeSchema,
  name: z.string().trim().min(1).max(255),
  capacity: capacitySchema,
  price: priceSchema.optional(),
  audience: audienceSchema.optional(),
  price_windows: priceWindowsSchema.optional(),
  /** Default: after the event's last ticket type. */
  display_order: displayOrderSchema.optional(),
  is_active: z.boolean().optional(),
});

export const ticketTypeUpdateSchema = z
  .strictObject({
    code: codeSchema.optional(),
    name: z.string().trim().min(1).max(255).optional(),
    capacity: capacitySchema,
    price: priceSchema.optional(),
    audience: audienceSchema.optional(),
    /** Left out keeps the schedule; a list replaces it as a whole; [] clears it (for new purchases). */
    price_windows: priceWindowsSchema.optional(),
    display_order: displayOrderSchema.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "Provide at least one field to update",
  });

export const ticketTypeParamsSchema = eventParamsSchema.extend({ ticketTypeId: uuidSchema });

export type TicketTypeCreateInput = z.output<typeof ticketTypeCreateSchema>;
export type TicketTypeUpdateInput = z.output<typeof ticketTypeUpdateSchema>;
export type PriceWindowInput = z.output<typeof priceWindowSchema>;

// One contract per endpoint (see middleware/validate.ts).
export const createTicketTypeRequest = { params: eventParamsSchema, body: ticketTypeCreateSchema } satisfies RequestContract;

export const listTicketTypesRequest = { params: eventParamsSchema } satisfies RequestContract;

export const updateTicketTypeRequest = { params: ticketTypeParamsSchema, body: ticketTypeUpdateSchema } satisfies RequestContract;

export const changeTicketTypeStatusRequest = { params: ticketTypeParamsSchema, body: statusChangeSchema } satisfies RequestContract;
