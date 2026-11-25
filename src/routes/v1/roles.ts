import { Router } from "express";
import { roleController } from "../../controllers/role.controller.js";
import { requireStaffAuthentication } from "../../middleware/authentication.js";
import { organizationScopeFromParams, requirePermission } from "../../middleware/permission.js";
import { validate } from "../../middleware/validate.js";
import { MODULE_CODES } from "../../utils/module-codes.js";
import { changeRoleStatusRequest, createRoleRequest, getRoleRequest, listRolesRequest, updateRoleRequest } from "../../validators/role.js";

/** Mounted at /v1/organizations/:organizationId/roles: the organization's roles (read in 2b, write in 2c). */
export const rolesRouter = Router({ mergeParams: true });

// Every route reads top to bottom: authenticate -> validate -> authorize -> controller.
rolesRouter.get(
  "/",
  requireStaffAuthentication,
  validate(listRolesRequest),
  requirePermission({ moduleCode: MODULE_CODES.ROLES, action: "view", scope: organizationScopeFromParams }),
  roleController.listRoles,
);

rolesRouter.post(
  "/",
  requireStaffAuthentication,
  validate(createRoleRequest),
  requirePermission({ moduleCode: MODULE_CODES.ROLES, action: "create", scope: organizationScopeFromParams }),
  roleController.createRole,
);

rolesRouter.get(
  "/:roleId",
  requireStaffAuthentication,
  validate(getRoleRequest),
  requirePermission({ moduleCode: MODULE_CODES.ROLES, action: "view", scope: organizationScopeFromParams }),
  roleController.getRole,
);

rolesRouter.patch(
  "/:roleId",
  requireStaffAuthentication,
  validate(updateRoleRequest),
  requirePermission({ moduleCode: MODULE_CODES.ROLES, action: "update", scope: organizationScopeFromParams }),
  roleController.updateRole,
);

rolesRouter.patch(
  "/:roleId/status",
  requireStaffAuthentication,
  validate(changeRoleStatusRequest),
  requirePermission({ moduleCode: MODULE_CODES.ROLES, action: "update", scope: organizationScopeFromParams }),
  roleController.changeRoleStatus,
);
