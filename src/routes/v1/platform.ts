import { Router } from "express";
import { platformController } from "../../controllers/platform.controller.js";
import { requireStaffAuthentication } from "../../middleware/authentication.js";
import { requirePermission } from "../../middleware/permission.js";
import { validate } from "../../middleware/validate.js";
import { MODULE_CODES } from "../../utils/module-codes.js";
import {
  changePlatformRoleStatusRequest,
  changePlatformStaffStatusRequest,
  createPlatformRoleRequest,
  createPlatformStaffRequest,
  deletePlatformStaffRequest,
  getPlatformRoleRequest,
  getPlatformStaffRequest,
  listPlatformRolesRequest,
  listPlatformStaffRequest,
  updatePlatformRoleRequest,
  updatePlatformStaffRequest,
} from "../../validators/platform.js";

/**
 * Mounted at /v1/platform (Phase 2e): platform roles and platform staff, platform scope only (the Super Admin, or
 * platform staff given Roles / Staff Assignments there). A tenant assignment never satisfies platform scope.
 * Every route reads top to bottom: authenticate -> validate -> authorize -> controller.
 */
export const platformRouter = Router();

const roles = (action: "view" | "create" | "update") => requirePermission({ moduleCode: MODULE_CODES.ROLES, action, scope: "platform" });
const staff = (action: "view" | "create" | "update" | "delete") => requirePermission({ moduleCode: MODULE_CODES.USER_ROLES, action, scope: "platform" });

platformRouter.get("/roles", requireStaffAuthentication, validate(listPlatformRolesRequest), roles("view"), platformController.listRoles);
platformRouter.post("/roles", requireStaffAuthentication, validate(createPlatformRoleRequest), roles("create"), platformController.createRole);
platformRouter.get("/roles/:roleId", requireStaffAuthentication, validate(getPlatformRoleRequest), roles("view"), platformController.getRole);
platformRouter.patch("/roles/:roleId", requireStaffAuthentication, validate(updatePlatformRoleRequest), roles("update"), platformController.updateRole);
platformRouter.patch(
  "/roles/:roleId/status",
  requireStaffAuthentication,
  validate(changePlatformRoleStatusRequest),
  roles("update"),
  platformController.changeRoleStatus,
);

platformRouter.get("/staff-assignments", requireStaffAuthentication, validate(listPlatformStaffRequest), staff("view"), platformController.listStaff);
platformRouter.post("/staff-assignments", requireStaffAuthentication, validate(createPlatformStaffRequest), staff("create"), platformController.assignStaff);
platformRouter.get(
  "/staff-assignments/:assignmentId",
  requireStaffAuthentication,
  validate(getPlatformStaffRequest),
  staff("view"),
  platformController.getStaff,
);
platformRouter.patch(
  "/staff-assignments/:assignmentId",
  requireStaffAuthentication,
  validate(updatePlatformStaffRequest),
  staff("update"),
  platformController.updateStaff,
);
platformRouter.patch(
  "/staff-assignments/:assignmentId/status",
  requireStaffAuthentication,
  validate(changePlatformStaffStatusRequest),
  staff("update"),
  platformController.changeStaffStatus,
);
platformRouter.delete(
  "/staff-assignments/:assignmentId",
  requireStaffAuthentication,
  validate(deletePlatformStaffRequest),
  staff("delete"),
  platformController.deleteStaff,
);
