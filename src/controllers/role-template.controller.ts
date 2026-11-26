import type { Request, Response } from "express";
import { getValidated } from "../middleware/validate.js";
import { roleTemplateService } from "../services/role-template.service.js";
import { sendSuccess } from "../utils/http.js";
import {
  changeRoleTemplateStatusRequest,
  createRoleTemplateRequest,
  getRoleTemplateRequest,
  listOrganizationRoleTemplatesRequest,
  listTemplateRolesRequest,
  updateRoleTemplateRequest,
} from "../validators/role-template.js";
import { getActorId } from "./helpers.js";

/** Role templates (Phase 2d): the Super Admin's library, and the active ones an Owner may start a role from. */
async function listTemplates(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, 200, await roleTemplateService.listTemplates(), "Role templates retrieved");
}

async function getTemplate(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, getRoleTemplateRequest);
  sendSuccess(res, 200, await roleTemplateService.getTemplate(params.templateId), "Role template retrieved");
}

async function createTemplate(req: Request, res: Response): Promise<void> {
  const { body } = getValidated(req, createRoleTemplateRequest);
  sendSuccess(res, 201, await roleTemplateService.createTemplate(body, getActorId(req)), "Role template created");
}

async function updateTemplate(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, updateRoleTemplateRequest);
  sendSuccess(res, 200, await roleTemplateService.updateTemplate(params.templateId, body, getActorId(req)), "Role template updated");
}

async function changeTemplateStatus(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, changeRoleTemplateStatusRequest);
  const template = await roleTemplateService.changeTemplateStatus(params.templateId, body.is_active, getActorId(req));
  sendSuccess(res, 200, template, body.is_active ? "Role template switched on" : "Role template switched off");
}

/** Every organization's roles made from this template (Phase 2e). */
async function listTemplateRoles(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, listTemplateRolesRequest);
  sendSuccess(res, 200, await roleTemplateService.listTemplateRoles(params.templateId), "Roles made from this template retrieved");
}

async function listForOrganization(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, listOrganizationRoleTemplatesRequest);
  sendSuccess(res, 200, await roleTemplateService.listForOrganization(params.organizationId), "Role templates retrieved");
}

export const roleTemplateController = {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  changeTemplateStatus,
  listTemplateRoles,
  listForOrganization,
};
