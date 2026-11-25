import type { Request, Response } from "express";
import { getValidated } from "../middleware/validate.js";
import { roleService } from "../services/role.service.js";
import { sendSuccess } from "../utils/http.js";
import { changeRoleStatusRequest, createRoleRequest, getRoleRequest, listRolesRequest, updateRoleRequest } from "../validators/role.js";
import { getStaffAuth } from "./helpers.js";

/** The editor: who they are and which assignment they are signed in as (the escalation check uses both). */
function editorOf(req: Request) {
  const auth = getStaffAuth(req);
  return { userId: auth.userId, assignmentId: auth.assignmentId };
}

async function listRoles(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, listRolesRequest);
  sendSuccess(res, 200, await roleService.listRoles(params.organizationId), "Roles retrieved");
}

async function getRole(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, getRoleRequest);
  sendSuccess(res, 200, await roleService.getRole(params.organizationId, params.roleId), "Role retrieved");
}

async function createRole(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, createRoleRequest);
  sendSuccess(res, 201, await roleService.createRole(params.organizationId, body, editorOf(req)), "Role created");
}

async function updateRole(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, updateRoleRequest);
  sendSuccess(res, 200, await roleService.updateRole(params.organizationId, params.roleId, body, editorOf(req)), "Role updated");
}

async function changeRoleStatus(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, changeRoleStatusRequest);
  sendSuccess(res, 200, await roleService.changeRoleStatus(params.organizationId, params.roleId, body.is_active, editorOf(req)), "Role status updated");
}

export const roleController = { listRoles, getRole, createRole, updateRole, changeRoleStatus };
