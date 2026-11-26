import { Router } from "express";
import { roleController } from "../../controllers/role.controller.js";
import { requireStaffAuthentication } from "../../middleware/authentication.js";
import { organizationScopeFromParams, requirePermission } from "../../middleware/permission.js";
import { validate } from "../../middleware/validate.js";
import { MODULE_CODES } from "../../utils/module-codes.js";
import { listGrantableModulesRequest } from "../../validators/role.js";

/**
 * Mounted at /v1/organizations/:organizationId/grantable-modules (Phase 2e): the modules and actions the role,
 * template and override grids offer. Readable by anyone who edits roles or staff (Roles › view or Staff Assignments ›
 * view). Every route reads top to bottom: authenticate -> validate -> authorize -> controller.
 */
export const grantableModulesRouter = Router({ mergeParams: true });

grantableModulesRouter.get(
  "/",
  requireStaffAuthentication,
  validate(listGrantableModulesRequest),
  requirePermission({
    scope: organizationScopeFromParams,
    anyOf: [
      { moduleCode: MODULE_CODES.ROLES, action: "view" },
      { moduleCode: MODULE_CODES.USER_ROLES, action: "view" },
    ],
  }),
  roleController.listGrantableModules,
);
