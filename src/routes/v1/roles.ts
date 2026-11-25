import { Router } from "express";
import { roleController } from "../../controllers/role.controller.js";
import { requireStaffAuthentication } from "../../middleware/authentication.js";
import { organizationScopeFromParams, requirePermission } from "../../middleware/permission.js";
import { validate } from "../../middleware/validate.js";
import { MODULE_CODES } from "../../utils/module-codes.js";
import { getRoleRequest, listRolesRequest } from "../../validators/role.js";

/** Mounted at /v1/organizations/:organizationId/roles: the organization's roles, read only (Phase 2b). */
export const rolesRouter = Router({ mergeParams: true });

// Every route reads top to bottom: authenticate -> validate -> authorize -> controller.
rolesRouter.get(
  "/",
  requireStaffAuthentication,
  validate(listRolesRequest),
  requirePermission({ moduleCode: MODULE_CODES.ROLES, action: "view", scope: organizationScopeFromParams }),
  roleController.listRoles,
);

rolesRouter.get(
  "/:roleId",
  requireStaffAuthentication,
  validate(getRoleRequest),
  requirePermission({ moduleCode: MODULE_CODES.ROLES, action: "view", scope: organizationScopeFromParams }),
  roleController.getRole,
);
