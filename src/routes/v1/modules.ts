import { Router } from "express";
import { moduleController } from "../../controllers/module.controller.js";
import { requireStaffAuthentication } from "../../middleware/authentication.js";
import { requirePermission } from "../../middleware/permission.js";
import { validate } from "../../middleware/validate.js";
import { MODULE_CODES } from "../../utils/module-codes.js";
import { changeModuleStatusRequest, createModuleRequest, listModulesRequest, updateModuleRequest } from "../../validators/module.js";

/**
 * Mounted at /v1/modules (Phase 2d; create, structure and status since Phase 2e): the platform's menu and permission
 * list, platform scope (Super Admin).
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

modulesRouter.post(
  "/",
  requireStaffAuthentication,
  validate(createModuleRequest),
  requirePermission({ moduleCode: MODULE_CODES.MODULES, action: "create", scope: "platform" }),
  moduleController.createModule,
);

modulesRouter.patch(
  "/:moduleId",
  requireStaffAuthentication,
  validate(updateModuleRequest),
  requirePermission({ moduleCode: MODULE_CODES.MODULES, action: "update", scope: "platform" }),
  moduleController.updateModule,
);

modulesRouter.patch(
  "/:moduleId/status",
  requireStaffAuthentication,
  validate(changeModuleStatusRequest),
  requirePermission({ moduleCode: MODULE_CODES.MODULES, action: "update", scope: "platform" }),
  moduleController.changeModuleStatus,
);
