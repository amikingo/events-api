import type { Request, Response } from "express";
import { getValidated } from "../middleware/validate.js";
import { checkInService } from "../services/check-in.service.js";
import { sendSuccess } from "../utils/http.js";
import { checkInRequest } from "../validators/check-in.js";
import { getActorId } from "./helpers.js";

/** Admission at the door (Phase 8 step 2): ADMITTED or ALREADY_CHECKED_IN, both 200. */
async function admit(req: Request, res: Response): Promise<void> {
  const { params, headers, body } = getValidated(req, checkInRequest);
  const result = await checkInService.admit({
    organizationId: params.organizationId,
    eventId: params.eventId,
    code: body.code,
    idempotencyKey: headers["idempotency-key"],
    actorId: getActorId(req) as string,
  });
  sendSuccess(res, 200, result, result.result === "ADMITTED" ? "Admitted" : "Already checked in");
}

export const checkInController = { admit };
