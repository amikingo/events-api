import { Router } from "express";
import { organizationController } from "../../controllers/organization.controller.js";
import { requireStaffAuthentication } from "../../middleware/authentication.js";
import { organizationScopeFromParams, requirePermission } from "../../middleware/permission.js";
import { validate } from "../../middleware/validate.js";
import { MODULE_CODES } from "../../utils/module-codes.js";
import { createOrganizationRequest, getOrganizationRequest, listOrganizationsRequest } from "../../validators/organization.js";

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
