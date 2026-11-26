import { Router } from "express";
import { checkInController } from "../../controllers/check-in.controller.js";
import { requireStaffAuthentication } from "../../middleware/authentication.js";
import { organizationScopeFromParams, requirePermission } from "../../middleware/permission.js";
import { validate } from "../../middleware/validate.js";
import { MODULE_CODES } from "../../utils/module-codes.js";
import { checkInRequest } from "../../validators/check-in.js";

/**
 * Mounted at /v1/organizations/:organizationId/events/:eventId/check-ins (Phase 8 step 2): admission at the door.
 * Guests › update, in the path's organization (door staff hold it). A scan and a typed code use this one call.
 */
export const checkInsRouter = Router({ mergeParams: true });

// Every route reads top to bottom: authenticate -> validate -> authorize -> controller.
checkInsRouter.post(
  "/",
  requireStaffAuthentication,
  validate(checkInRequest),
  requirePermission({ moduleCode: MODULE_CODES.REGISTRATIONS, action: "update", scope: organizationScopeFromParams }),
  checkInController.admit,
);
