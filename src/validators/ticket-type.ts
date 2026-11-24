import { z } from "zod";
import type { RequestContract } from "../middleware/validate.js";
import { codeSchema, statusChangeSchema, uuidSchema } from "./common.js";
import { eventParamsSchema } from "./event.js";

/** Optional separate limit for this category; null means it draws only on the event's overall limit. */
const capacitySchema = z.number().int().positive().max(1_000_000).nullable().optional();
const displayOrderSchema = z.number().int().min(0).max(10_000);

export const ticketTypeCreateSchema = z.strictObject({
  /** Unique within the event, stored upper-case (e.g. "vip" → "VIP"). */
  code: codeSchema,
  name: z.string().trim().min(1).max(255),
  capacity: capacitySchema,
  /** Default: after the event's last ticket type. */
  display_order: displayOrderSchema.optional(),
  is_active: z.boolean().optional(),
});

export const ticketTypeUpdateSchema = z
  .strictObject({
    code: codeSchema.optional(),
    name: z.string().trim().min(1).max(255).optional(),
    capacity: capacitySchema,
    display_order: displayOrderSchema.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "Provide at least one field to update",
  });

export const ticketTypeParamsSchema = eventParamsSchema.extend({ ticketTypeId: uuidSchema });

export type TicketTypeCreateInput = z.output<typeof ticketTypeCreateSchema>;
export type TicketTypeUpdateInput = z.output<typeof ticketTypeUpdateSchema>;

// One contract per endpoint (see middleware/validate.ts).
export const createTicketTypeRequest = { params: eventParamsSchema, body: ticketTypeCreateSchema } satisfies RequestContract;

export const listTicketTypesRequest = { params: eventParamsSchema } satisfies RequestContract;

export const updateTicketTypeRequest = { params: ticketTypeParamsSchema, body: ticketTypeUpdateSchema } satisfies RequestContract;

export const changeTicketTypeStatusRequest = { params: ticketTypeParamsSchema, body: statusChangeSchema } satisfies RequestContract;
