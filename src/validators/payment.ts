import { z } from "zod";
import type { RequestContract } from "../middleware/validate.js";
import { organizationIdParamsSchema } from "./common.js";

/**
 * Paid checkout through Cheche Pay v2 (Phase 7 step 3b).
 * - The buyer's order page and its payment check: the order reference in the path and the order token in the
 *   `X-Order-Token` header (never in the URL, so it stays out of logs and browser history).
 * - Cheche Pay's webhook: POST /v1/payments/cheche/webhook/{organizationId}. The body is read from its raw bytes (the
 *   signature covers them) and only names the tx_ref to verify; it is never trusted for the payment's state.
 */
export const publicOrderParamsSchema = z.strictObject({ reference: z.string().trim().regex(/^[A-HJKMNP-Z2-9]{8,10}$/, "An order reference") });
export const orderTokenHeadersSchema = z.object({ "x-order-token": z.string().trim().regex(/^[A-Za-z0-9_-]{20,100}$/, "The order token from checkout") });

/** Cheche Pay's webhook event, as far as we read it ({ event: "payment.…", data: { tx_ref } }); other fields pass. */
export const chechePayWebhookSchema = z.looseObject({
  event: z.string().max(100).optional(),
  data: z.looseObject({ tx_ref: z.string().max(100).optional() }).optional(),
});

export const chechePayWebhookHeadersSchema = z.object({ "x-cheche-signature": z.string().max(200).optional() });

// One contract per endpoint (see middleware/validate.ts).
export const getPublicOrderRequest = { params: publicOrderParamsSchema, headers: orderTokenHeadersSchema } satisfies RequestContract;
export const startPublicPaymentRequest = { params: publicOrderParamsSchema, headers: orderTokenHeadersSchema } satisfies RequestContract;
export const checkPublicPaymentRequest = { params: publicOrderParamsSchema, headers: orderTokenHeadersSchema } satisfies RequestContract;
export const chechePayWebhookRequest = {
  params: organizationIdParamsSchema,
  headers: chechePayWebhookHeadersSchema,
  body: chechePayWebhookSchema,
} satisfies RequestContract;
