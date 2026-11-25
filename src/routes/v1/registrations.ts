import { Router } from "express";
import { registrationController } from "../../controllers/registration.controller.js";
import { requireStaffAuthentication } from "../../middleware/authentication.js";
import { organizationScopeFromParams, requirePermission } from "../../middleware/permission.js";
import { validate } from "../../middleware/validate.js";
import { MODULE_CODES } from "../../utils/module-codes.js";
import {
  changeRegistrationStatusRequest,
  createRegistrationRequest,
  getRegistrationRequest,
  getRegistrationSummaryRequest,
  listRegistrationsRequest,
} from "../../validators/registration.js";

/**
 * Mounted at /v1/organizations/:organizationId/events/:eventId/registrations (mergeParams exposes both ids). The
 * event's guest list. Organization-level back office: branch-limited staff get 403 during the pilot.
 */
export const registrationsRouter = Router({ mergeParams: true });

// Every route reads top to bottom: authenticate -> validate -> authorize -> controller.
registrationsRouter.post(
  "/",
  requireStaffAuthentication,
  validate(createRegistrationRequest),
  requirePermission({ moduleCode: MODULE_CODES.REGISTRATIONS, action: "create", scope: organizationScopeFromParams }),
  registrationController.registerGuest,
);

registrationsRouter.get(
  "/",
  requireStaffAuthentication,
  validate(listRegistrationsRequest),
  requirePermission({ moduleCode: MODULE_CODES.REGISTRATIONS, action: "view", scope: organizationScopeFromParams }),
  registrationController.listRegistrations,
);

// Before /:registrationId, so "summary" is never read as an id.
registrationsRouter.get(
  "/summary",
  requireStaffAuthentication,
  validate(getRegistrationSummaryRequest),
  requirePermission({ moduleCode: MODULE_CODES.REGISTRATIONS, action: "view", scope: organizationScopeFromParams }),
  registrationController.getRegistrationSummary,
);

registrationsRouter.get(
  "/:registrationId",
  requireStaffAuthentication,
  validate(getRegistrationRequest),
  requirePermission({ moduleCode: MODULE_CODES.REGISTRATIONS, action: "view", scope: organizationScopeFromParams }),
  registrationController.getRegistration,
);

// Cancel (frees the place) or reactivate.
registrationsRouter.patch(
  "/:registrationId/status",
  requireStaffAuthentication,
  validate(changeRegistrationStatusRequest),
  requirePermission({ moduleCode: MODULE_CODES.REGISTRATIONS, action: "update", scope: organizationScopeFromParams }),
  registrationController.changeRegistrationStatus,
);
