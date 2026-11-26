import type { Request, Response } from "express";
import { getValidated } from "../middleware/validate.js";
import { paymentService } from "../services/payment.service.js";
import { sendSuccess } from "../utils/http.js";
import { chechePayWebhookRequest } from "../validators/payment.js";

/** Cheche Pay v2's webhook (Phase 7 step 3b): checked against the raw body, then verified with Cheche Pay. */
async function webhook(req: Request, res: Response): Promise<void> {
  const { params, headers } = getValidated(req, chechePayWebhookRequest);
  const result = await paymentService.handleWebhook({ organizationId: params.organizationId, rawBody: req.rawBody ?? null, signature: headers["x-cheche-signature"] });
  sendSuccess(res, 200, result, "Cheche Pay webhook received");
}

export const paymentController = { webhook };
