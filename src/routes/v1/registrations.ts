import { Router } from "express";
import { registrationController } from "../../controllers/registration.controller.js";
import { requireStaffAuthentication } from "../../middleware/authentication.js";
import { organizationScopeFromParams, requirePermission } from "../../middleware/permission.js";
import { validate } from "../../middleware/validate.js";
import { MODULE_CODES } from "../../utils/module-codes.js";
import {
  changeRegistrationStatusRequest,
  changeRegistrationTicketTypeRequest,
  createRegistrationRequest,
  exportRegistrationsRequest,
  getRegistrationRequest,
  getRegistrationSummaryRequest,
  listRegistrationsRequest,
  returnRegistrationRequest,
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

// The guest list as CSV: its own right (Guests › export), since the file holds every guest's mobile. Before /:registrationId.
registrationsRouter.get(
  "/export",
  requireStaffAuthentication,
  validate(exportRegistrationsRequest),
  requirePermission({ moduleCode: MODULE_CODES.REGISTRATIONS, action: "export", scope: organizationScopeFromParams }),
  registrationController.exportRegistrations,
);

registrationsRouter.get(
  "/:registrationId",
  requireStaffAuthentication,
  validate(getRegistrationRequest),
  requirePermission({ moduleCode: MODULE_CODES.REGISTRATIONS, action: "view", scope: organizationScopeFromParams }),
  registrationController.getRegistration,
);

// Phase 8: return one confirmed, unused ticket (a paid one opens its refund case).
registrationsRouter.post(
  "/:registrationId/return",
  requireStaffAuthentication,
  validate(returnRegistrationRequest),
  requirePermission({ moduleCode: MODULE_CODES.REGISTRATIONS, action: "update", scope: organizationScopeFromParams }),
  registrationController.returnRegistration,
);

// Cancel (frees the place) or reactivate.
registrationsRouter.patch(
  "/:registrationId/status",
  requireStaffAuthentication,
  validate(changeRegistrationStatusRequest),
  requirePermission({ moduleCode: MODULE_CODES.REGISTRATIONS, action: "update", scope: organizationScopeFromParams }),
  registrationController.changeRegistrationStatus,
);

// Move a confirmed guest to another ticket type (same code, no SMS).
registrationsRouter.patch(
  "/:registrationId/ticket-type",
  requireStaffAuthentication,
  validate(changeRegistrationTicketTypeRequest),
  requirePermission({ moduleCode: MODULE_CODES.REGISTRATIONS, action: "update", scope: organizationScopeFromParams }),
  registrationController.changeRegistrationTicketType,
);
