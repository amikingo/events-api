import { z } from "zod";
import type { RequestContract } from "../middleware/validate.js";
import type { RegistrationStatus } from "../models/registration.js";
import { idempotencyKeySchema, paginationQuerySchema, uuidSchema } from "./common.js";
import { eventParamsSchema } from "./event.js";
import { personInputSchema, searchTextSchema } from "./person.js";

const statusSchema = z.enum(["CONFIRMED", "CANCELLED"] as const satisfies readonly RegistrationStatus[]);

/**
 * Staff entry: an existing guest profile (`person_id`, after confirming the guest's identity) or a new one
 * (`person`), never both. `ticket_type_id` may be left out when the event has exactly one active ticket type.
 */
export const registrationCreateSchema = z
  .strictObject({
    person_id: uuidSchema.optional(),
    person: personInputSchema.optional(),
    ticket_type_id: uuidSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.person_id === undefined && value.person === undefined) {
      ctx.addIssue({ code: "custom", path: ["person_id"], message: "Send person_id (an existing guest) or person (a new guest)" });
    } else if (value.person_id !== undefined && value.person !== undefined) {
      ctx.addIssue({ code: "custom", path: ["person"], message: "Send either person_id or person, not both" });
    }
  });

/** CANCELLED frees the place; CONFIRMED reactivates a cancelled registration, with every check repeated. */
export const registrationStatusChangeSchema = z.strictObject({ status: statusSchema });

export const registrationParamsSchema = eventParamsSchema.extend({ registrationId: uuidSchema });

export const registrationListQuerySchema = paginationQuerySchema.extend({
  status: statusSchema.optional(),
  ticket_type_id: uuidSchema.optional(),
  q: searchTextSchema,
});

export type RegistrationCreateInput = z.output<typeof registrationCreateSchema>;
export type RegistrationListQuery = z.output<typeof registrationListQuerySchema>;
export type RegistrationTargetStatus = z.output<typeof statusSchema>;

/** Optional for staff: a key makes a double-clicked "create guest and register" safe (same request, same result). */
export const staffRegistrationHeadersSchema = z.object({ "idempotency-key": idempotencyKeySchema.optional() });

// One contract per endpoint (see middleware/validate.ts).
export const createRegistrationRequest = {
  params: eventParamsSchema,
  headers: staffRegistrationHeadersSchema,
  body: registrationCreateSchema,
} satisfies RequestContract;

export const listRegistrationsRequest = { params: eventParamsSchema, query: registrationListQuerySchema } satisfies RequestContract;

export const getRegistrationSummaryRequest = { params: eventParamsSchema } satisfies RequestContract;

export const getRegistrationRequest = { params: registrationParamsSchema } satisfies RequestContract;

export const changeRegistrationStatusRequest = {
  params: registrationParamsSchema,
  body: registrationStatusChangeSchema,
} satisfies RequestContract;
