import { z } from "zod";
import type { RequestContract } from "../middleware/validate.js";
import { booleanQuerySchema, nullableText, organizationIdParamsSchema, paginationQuerySchema, statusChangeSchema, uuidSchema } from "./common.js";

/** ISO 3166-1 alpha-2, stored upper-case (e.g. "et" → "ET"). "" or null clears it. */
const countrySchema = z
  .union([
    z.literal(""),
    z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/, "Use the two-letter country code, e.g. ET"),
  ])
  .nullable()
  .optional()
  .transform((value) => (value === "" ? null : value));

/** How many people the place holds. An event's own capacity sets its booking limit. */
const capacitySchema = z.number().int().positive().max(1_000_000).nullable().optional();

export const venueCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(255),
  address: nullableText(500),
  city: nullableText(120),
  country: countrySchema,
  capacity: capacitySchema,
  is_active: z.boolean().optional(),
});

export const venueUpdateSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(255).optional(),
    address: nullableText(500),
    city: nullableText(120),
    country: countrySchema,
    capacity: capacitySchema,
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "Provide at least one field to update",
  });

export const venueParamsSchema = organizationIdParamsSchema.extend({ venueId: uuidSchema });

export const venueListQuerySchema = paginationQuerySchema.extend({ is_active: booleanQuerySchema });

export type VenueCreateInput = z.output<typeof venueCreateSchema>;
export type VenueUpdateInput = z.output<typeof venueUpdateSchema>;
export type VenueListQuery = z.output<typeof venueListQuerySchema>;

// One contract per endpoint (see middleware/validate.ts).
export const createVenueRequest = { params: organizationIdParamsSchema, body: venueCreateSchema } satisfies RequestContract;

export const listVenuesRequest = { params: organizationIdParamsSchema, query: venueListQuerySchema } satisfies RequestContract;

export const getVenueRequest = { params: venueParamsSchema } satisfies RequestContract;

export const updateVenueRequest = { params: venueParamsSchema, body: venueUpdateSchema } satisfies RequestContract;

export const changeVenueStatusRequest = { params: venueParamsSchema, body: statusChangeSchema } satisfies RequestContract;
