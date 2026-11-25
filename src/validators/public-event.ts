import { z } from "zod";
import type { RequestContract } from "../middleware/validate.js";
import { paginationQuerySchema } from "./common.js";
import { slugSchema } from "./organization.js";

export const publicEventListQuerySchema = paginationQuerySchema.extend({
  /** Exact category, ignoring case (no partial match). */
  category: z.string().trim().min(1).max(80).optional(),
  /** An organization's slug. */
  organization: slugSchema.optional(),
});

export const publicEventParamsSchema = z.strictObject({ organizationSlug: slugSchema, eventSlug: slugSchema });

export type PublicEventListQuery = z.output<typeof publicEventListQuerySchema>;

// One contract per endpoint (see middleware/validate.ts).
export const listPublicEventsRequest = { query: publicEventListQuerySchema } satisfies RequestContract;

export const getPublicEventRequest = { params: publicEventParamsSchema } satisfies RequestContract;
