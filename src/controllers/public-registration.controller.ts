import type { Request, Response } from "express";
import { getValidated } from "../middleware/validate.js";
import { publicRegistrationService } from "../services/public-registration.service.js";
import { sendSuccess } from "../utils/http.js";
import { createPublicRegistrationRequest } from "../validators/public-registration.js";

/** 201 for a new registration; 200 with the same reply when the same request (Idempotency-Key) is sent again. */
async function registerForEvent(req: Request, res: Response): Promise<void> {
  const { params, headers, body } = getValidated(req, createPublicRegistrationRequest);
  const { registration, replayed } = await publicRegistrationService.registerFromPublicForm(
    params.organizationSlug,
    params.eventSlug,
    headers["idempotency-key"],
    body,
  );
  sendSuccess(res, replayed ? 200 : 201, registration, replayed ? "Already registered with this request" : "Registered");
}

export const publicRegistrationController = { registerForEvent };
