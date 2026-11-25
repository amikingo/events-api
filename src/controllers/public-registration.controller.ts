import type { Request, Response } from "express";
import { getValidated } from "../middleware/validate.js";
import { publicRegistrationService } from "../services/public-registration.service.js";
import { sendSuccess } from "../utils/http.js";
import { createPublicRegistrationRequest } from "../validators/public-registration.js";
import { getOptionalCustomerAuth } from "./helpers.js";

/**
 * 201 for a place taken; 200 with the same reply when the same request (Idempotency-Key) is sent again, or when a
 * signed-in guest is already registered for the event (Phase 6).
 */
async function registerForEvent(req: Request, res: Response): Promise<void> {
  const { params, headers, body } = getValidated(req, createPublicRegistrationRequest);
  const { registration, outcome } = await publicRegistrationService.registerFromPublicForm(
    params.organizationSlug,
    params.eventSlug,
    headers["idempotency-key"],
    body,
    getOptionalCustomerAuth(req),
  );
  if (outcome === "REPLAYED") {
    sendSuccess(res, 200, registration, "Already registered with this request");
    return;
  }
  if (outcome === "UNCHANGED") {
    sendSuccess(res, 200, registration, "You're already registered for this event");
    return;
  }
  sendSuccess(res, 201, registration, "Registered");
}

export const publicRegistrationController = { registerForEvent };
