import { z } from "zod";
import type { RequestContract } from "../middleware/validate.js";
import { mobileSchema } from "./auth.js";
import { codeSchema, contactEmailSchema, countryCodeSchema, idempotencyKeySchema, nullableText } from "./common.js";
import { publicEventParamsSchema } from "./public-event.js";

/**
 * The public registration form. Both names are required. Without an account, an Ethiopian mobile is required too
 * (the confirmation SMS goes to that number, stored as +251…); the service enforces it. Signed in with a Cheche
 * account (Phase 6), `phone` is ignored: the account's verified mobile is used. Ticket types are chosen by code, as the public event page shows them;
 * `ticket_type_code` may be left out when the event has one active ticket type. `privacy_notice_version` is the
 * version of the notice the form showed (from the event page's privacy_notice).
 */
export const publicRegistrationSchema = z.strictObject({
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
  phone: mobileSchema.optional(),
  email: contactEmailSchema,
  affiliation_name: nullableText(200),
  country: countryCodeSchema.nullable().optional(),
  ticket_type_code: codeSchema.optional(),
  privacy_notice_version: z.string().trim().min(1).max(40),
});

/** Required: the same key with the same form returns the original registration instead of a second one. */
export const publicRegistrationHeadersSchema = z.object({ "idempotency-key": idempotencyKeySchema });

export type PublicRegistrationInput = z.output<typeof publicRegistrationSchema>;

// One contract per endpoint (see middleware/validate.ts).
export const createPublicRegistrationRequest = {
  params: publicEventParamsSchema,
  headers: publicRegistrationHeadersSchema,
  body: publicRegistrationSchema,
} satisfies RequestContract;
