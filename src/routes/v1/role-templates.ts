import { Router } from "express";
import { roleTemplateController } from "../../controllers/role-template.controller.js";
import { requireStaffAuthentication } from "../../middleware/authentication.js";
import { organizationScopeFromParams, requirePermission } from "../../middleware/permission.js";
import { validate } from "../../middleware/validate.js";
import { MODULE_CODES } from "../../utils/module-codes.js";
import {
  changeRoleTemplateStatusRequest,
  createRoleTemplateRequest,
  getRoleTemplateRequest,
  listOrganizationRoleTemplatesRequest,
  listRoleTemplatesRequest,
  updateRoleTemplateRequest,
} from "../../validators/role-template.js";

/**
 * Mounted at /v1/role-templates (Phase 2d): the platform's role template library, platform scope (Super Admin).
 * Every route reads top to bottom: authenticate -> validate -> authorize -> controller.
 */
export const roleTemplatesRouter = Router();

roleTemplatesRouter.get(
  "/",
  requireStaffAuthentication,
  validate(listRoleTemplatesRequest),
  requirePermission({ moduleCode: MODULE_CODES.ROLE_TEMPLATES, action: "view", scope: "platform" }),
  roleTemplateController.listTemplates,
);

roleTemplatesRouter.post(
  "/",
  requireStaffAuthentication,
  validate(createRoleTemplateRequest),
  requirePermission({ moduleCode: MODULE_CODES.ROLE_TEMPLATES, action: "create", scope: "platform" }),
  roleTemplateController.createTemplate,
);

roleTemplatesRouter.get(
  "/:templateId",
  requireStaffAuthentication,
  validate(getRoleTemplateRequest),
  requirePermission({ moduleCode: MODULE_CODES.ROLE_TEMPLATES, action: "view", scope: "platform" }),
  roleTemplateController.getTemplate,
);

roleTemplatesRouter.patch(
  "/:templateId",
  requireStaffAuthentication,
  validate(updateRoleTemplateRequest),
  requirePermission({ moduleCode: MODULE_CODES.ROLE_TEMPLATES, action: "update", scope: "platform" }),
  roleTemplateController.updateTemplate,
);

roleTemplatesRouter.patch(
  "/:templateId/status",
  requireStaffAuthentication,
  validate(changeRoleTemplateStatusRequest),
  requirePermission({ moduleCode: MODULE_CODES.ROLE_TEMPLATES, action: "update", scope: "platform" }),
  roleTemplateController.changeTemplateStatus,
);

/**
 * Mounted at /v1/organizations/:organizationId/role-templates: the active templates an Owner may start a role from.
 * Needs Roles › create in that organization (the role itself is then made with POST /roles).
 */
export const organizationRoleTemplatesRouter = Router({ mergeParams: true });

organizationRoleTemplatesRouter.get(
  "/",
  requireStaffAuthentication,
  validate(listOrganizationRoleTemplatesRequest),
  requirePermission({ moduleCode: MODULE_CODES.ROLES, action: "create", scope: organizationScopeFromParams }),
  roleTemplateController.listForOrganization,
);
