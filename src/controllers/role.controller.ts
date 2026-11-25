import type { Request, Response } from "express";
import { getValidated } from "../middleware/validate.js";
import { roleService } from "../services/role.service.js";
import { sendSuccess } from "../utils/http.js";
import { getRoleRequest, listRolesRequest } from "../validators/role.js";

async function listRoles(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, listRolesRequest);
  sendSuccess(res, 200, await roleService.listRoles(params.organizationId), "Roles retrieved");
}

async function getRole(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, getRoleRequest);
  sendSuccess(res, 200, await roleService.getRole(params.organizationId, params.roleId), "Role retrieved");
}

export const roleController = { listRoles, getRole };
