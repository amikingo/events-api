import type { Request, Response } from "express";
import { getValidated } from "../middleware/validate.js";
import { paymentService } from "../services/payment.service.js";
import { sendSuccess } from "../utils/http.js";
import {
  chechePayNotifyGetRequest,
  chechePayNotifyPostRequest,
  getChechePayServiceRequest,
  readChechePayNotification,
  updateChechePayServiceRequest,
} from "../validators/payment.js";
import { getActorId } from "./helpers.js";

/** Paid checkout through Cheche Pay (Phase 7 step 3): the organizer's service code, and Cheche Pay's callback. */
async function getChechePayService(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, getChechePayServiceRequest);
  sendSuccess(res, 200, await paymentService.getChechePaySetting(params.organizationId), "Cheche Pay setting retrieved");
}

async function updateChechePayService(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, updateChechePayServiceRequest);
  const setting = await paymentService.setChechePayService(params.organizationId, body.cheche_pay_service, getActorId(req));
  sendSuccess(res, 200, setting, setting.warnings.length > 0 ? "Saved, with a warning" : "Cheche Pay setting saved");
}

/** notify-from-chechepay, POST (body) or GET (query), as bookings accepts it. */
async function notifyPost(req: Request, res: Response): Promise<void> {
  const { body } = getValidated(req, chechePayNotifyPostRequest);
  sendSuccess(res, 200, await paymentService.handleNotification(readChechePayNotification(body)), "Cheche Pay notification received");
}

async function notifyGet(req: Request, res: Response): Promise<void> {
  const { query } = getValidated(req, chechePayNotifyGetRequest);
  sendSuccess(res, 200, await paymentService.handleNotification(readChechePayNotification(query)), "Cheche Pay notification received");
}

export const paymentController = { getChechePayService, updateChechePayService, notifyPost, notifyGet };
