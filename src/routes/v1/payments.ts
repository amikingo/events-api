import { Router } from "express";
import { paymentController } from "../../controllers/payment.controller.js";
import { requireStaffAuthentication } from "../../middleware/authentication.js";
import { requirePermission } from "../../middleware/permission.js";
import { publicReadLimiter } from "../../middleware/rate-limit.js";
import { validate } from "../../middleware/validate.js";
import { MODULE_CODES } from "../../utils/module-codes.js";
import {
  chechePayNotifyGetRequest,
  chechePayNotifyPostRequest,
  getChechePayServiceRequest,
  updateChechePayServiceRequest,
} from "../../validators/payment.js";

/**
 * Mounted at /v1/payments (Phase 7 step 3): Cheche Pay's callback, POST and GET, as bookings_api has it. No login and
 * no signature (the legacy API has neither): see paymentService for the rules and the known risk.
 */
export const paymentsRouter = Router();

paymentsRouter.post("/cheche/notify", publicReadLimiter, validate(chechePayNotifyPostRequest), paymentController.notifyPost);
paymentsRouter.get("/cheche/notify", publicReadLimiter, validate(chechePayNotifyGetRequest), paymentController.notifyGet);

/**
 * Mounted at /v1/organizations/:organizationId/cheche-pay-service (Phase 7 step 3): the Cheche Pay service code that
 * receives the organizer's money. Platform scope only (the Super Admin), as in bookings: an Owner can never redirect
 * an event's money.
 */
export const chechePayServiceRouter = Router({ mergeParams: true });

// Every route reads top to bottom: authenticate -> validate -> authorize -> controller.
chechePayServiceRouter.get(
  "/",
  requireStaffAuthentication,
  validate(getChechePayServiceRequest),
  requirePermission({ moduleCode: MODULE_CODES.ORGANIZATIONS, action: "view", scope: "platform" }),
  paymentController.getChechePayService,
);

chechePayServiceRouter.put(
  "/",
  requireStaffAuthentication,
  validate(updateChechePayServiceRequest),
  requirePermission({ moduleCode: MODULE_CODES.ORGANIZATIONS, action: "update", scope: "platform" }),
  paymentController.updateChechePayService,
);
