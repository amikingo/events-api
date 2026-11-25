import { Router } from "express";
import { moduleController } from "../../controllers/module.controller.js";
import { requireStaffAuthentication } from "../../middleware/authentication.js";
import { requirePermission } from "../../middleware/permission.js";
import { validate } from "../../middleware/validate.js";
import { MODULE_CODES } from "../../utils/module-codes.js";
import { listModulesRequest, updateModuleRequest } from "../../validators/module.js";

/**
 * Mounted at /v1/modules (Phase 2d): the platform's menu and permission list, platform scope (Super Admin).
 * Every route reads top to bottom: authenticate -> validate -> authorize -> controller.
 */
export const modulesRouter = Router();

modulesRouter.get(
  "/",
  requireStaffAuthentication,
  validate(listModulesRequest),
  requirePermission({ moduleCode: MODULE_CODES.MODULES, action: "view", scope: "platform" }),
  moduleController.listModules,
);

modulesRouter.patch(
  "/:moduleId",
  requireStaffAuthentication,
  validate(updateModuleRequest),
  requirePermission({ moduleCode: MODULE_CODES.MODULES, action: "update", scope: "platform" }),
  moduleController.updateModule,
);
