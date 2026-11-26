import { Router } from "express";
import { paymentController } from "../../controllers/payment.controller.js";
import { createJsonRateLimiter } from "../../middleware/rate-limit.js";
import { validate } from "../../middleware/validate.js";
import { chechePayWebhookRequest } from "../../validators/payment.js";

/**
 * Mounted at /v1/payments (Phase 7 step 3b): Cheche Pay v2's webhook for one organizer, as bookings_api has it. No
 * login. When the organizer's webhook secret is saved, X-Cheche-Signature must match (HMAC-SHA256 of the raw body).
 * Either way the body only names a tx_ref: its state always comes from merchant-verify (paymentService.settle).
 */
export const paymentsRouter = Router();

// Each callback costs a merchant-verify call, so cap them per IP. Cheche Pay's own retries stay well under this.
const chechePayCallbackLimiter = createJsonRateLimiter({ windowMs: 60_000, limit: 120, message: "Too many Cheche Pay callbacks" });

paymentsRouter.post("/cheche/webhook/:organizationId", chechePayCallbackLimiter, validate(chechePayWebhookRequest), paymentController.webhook);
