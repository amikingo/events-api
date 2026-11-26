import { Router } from "express";
import { chechePayCredentialController } from "../../controllers/cheche-pay-credential.controller.js";
import { requireStaffAuthentication } from "../../middleware/authentication.js";
import { requirePermission } from "../../middleware/permission.js";
import { validate } from "../../middleware/validate.js";
import { MODULE_CODES } from "../../utils/module-codes.js";
import {
  checkChechePayCredentialRequest,
  deleteChechePayCredentialRequest,
  getChechePayCredentialRequest,
  saveChechePayCredentialRequest,
} from "../../validators/cheche-pay-credential.js";

/**
 * Mounted at /v1/organizations/:organizationId/cheche-pay (Phase 7 step 3b): the organizer's Cheche Pay v2 keys, which
 * decide whose business receives the money. Platform scope only (the Super Admin), as in bookings: an Owner can never
 * redirect an event's money.
 */
export const chechePayCredentialsRouter = Router({ mergeParams: true });

// Every route reads top to bottom: authenticate -> validate -> authorize -> controller.
chechePayCredentialsRouter.get(
  "/",
  requireStaffAuthentication,
  validate(getChechePayCredentialRequest),
  requirePermission({ moduleCode: MODULE_CODES.ORGANIZATIONS, action: "view", scope: "platform" }),
  chechePayCredentialController.get,
);

chechePayCredentialsRouter.put(
  "/",
  requireStaffAuthentication,
  validate(saveChechePayCredentialRequest),
  requirePermission({ moduleCode: MODULE_CODES.ORGANIZATIONS, action: "update", scope: "platform" }),
  chechePayCredentialController.save,
);

chechePayCredentialsRouter.delete(
  "/",
  requireStaffAuthentication,
  validate(deleteChechePayCredentialRequest),
  requirePermission({ moduleCode: MODULE_CODES.ORGANIZATIONS, action: "update", scope: "platform" }),
  chechePayCredentialController.remove,
);

chechePayCredentialsRouter.post(
  "/check",
  requireStaffAuthentication,
  validate(checkChechePayCredentialRequest),
  requirePermission({ moduleCode: MODULE_CODES.ORGANIZATIONS, action: "update", scope: "platform" }),
  chechePayCredentialController.check,
);
