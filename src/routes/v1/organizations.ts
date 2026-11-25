import { Router } from "express";
import { organizationController } from "../../controllers/organization.controller.js";
import { requireStaffAuthentication } from "../../middleware/authentication.js";
import { organizationScopeFromParams, requirePermission } from "../../middleware/permission.js";
import { validate } from "../../middleware/validate.js";
import { MODULE_CODES } from "../../utils/module-codes.js";
import {
  changeOrganizationStatusRequest,
  createOrganizationRequest,
  getOrganizationRequest,
  listOrganizationsRequest,
  updateOrganizationSettingsRequest,
} from "../../validators/organization.js";

/** Mounted at /v1/organizations. */
export const organizationsRouter = Router();

// Creating and listing tenants are platform operations: tenant roles can never satisfy them.
organizationsRouter.post(
  "/",
  requireStaffAuthentication,
  validate(createOrganizationRequest),
  requirePermission({ moduleCode: MODULE_CODES.ORGANIZATIONS, action: "create", scope: "platform" }),
  organizationController.createOrganization,
);

organizationsRouter.get(
  "/",
  requireStaffAuthentication,
  validate(listOrganizationsRequest),
  requirePermission({ moduleCode: MODULE_CODES.ORGANIZATIONS, action: "view", scope: "platform" }),
  organizationController.listOrganizations,
);

// Reading one tenant is tenant-scoped: its own staff (or platform staff) may read it.
organizationsRouter.get(
  "/:organizationId",
  requireStaffAuthentication,
  validate(getOrganizationRequest),
  requirePermission({ moduleCode: MODULE_CODES.ORGANIZATIONS, action: "view", scope: organizationScopeFromParams }),
  organizationController.getOrganization,
);

// Switching a tenant off or on is a platform operation: only the platform Super Admin, never its own staff.
organizationsRouter.patch(
  "/:organizationId/status",
  requireStaffAuthentication,
  validate(changeOrganizationStatusRequest),
  requirePermission({ moduleCode: MODULE_CODES.ORGANIZATIONS, action: "update", scope: "platform" }),
  organizationController.changeOrganizationStatus,
);

// The organization's own details and defaults (name, description, country, timezone, currency): its owner may edit them.
organizationsRouter.patch(
  "/:organizationId",
  requireStaffAuthentication,
  validate(updateOrganizationSettingsRequest),
  requirePermission({ moduleCode: MODULE_CODES.ORGANIZATIONS, action: "update", scope: organizationScopeFromParams }),
  organizationController.updateOrganizationSettings,
);
