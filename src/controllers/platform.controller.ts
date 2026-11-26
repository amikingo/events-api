import type { Request, Response } from "express";
import { getValidated } from "../middleware/validate.js";
import { platformRoleService } from "../services/platform-role.service.js";
import { platformStaffService } from "../services/platform-staff.service.js";
import { sendList, sendNoContent, sendSuccess } from "../utils/http.js";
import {
  changePlatformRoleStatusRequest,
  changePlatformStaffStatusRequest,
  createPlatformRoleRequest,
  createPlatformStaffRequest,
  deletePlatformStaffRequest,
  getPlatformRoleRequest,
  getPlatformStaffRequest,
  listPlatformStaffRequest,
  updatePlatformRoleRequest,
  updatePlatformStaffRequest,
} from "../validators/platform.js";
import { getActorId, getStaffAuth } from "./helpers.js";

/** Platform roles and platform staff (Phase 2e). The editor is the signed-in assignment (the escalation rule uses it). */
function editorOf(req: Request) {
  const auth = getStaffAuth(req);
  return { userId: auth.userId, assignmentId: auth.assignmentId };
}

async function listRoles(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, 200, await platformRoleService.listRoles(), "Platform roles retrieved");
}

async function getRole(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, getPlatformRoleRequest);
  sendSuccess(res, 200, await platformRoleService.getRole(params.roleId), "Platform role retrieved");
}

async function createRole(req: Request, res: Response): Promise<void> {
  const { body } = getValidated(req, createPlatformRoleRequest);
  sendSuccess(res, 201, await platformRoleService.createRole(body, editorOf(req)), "Platform role created");
}

async function updateRole(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, updatePlatformRoleRequest);
  sendSuccess(res, 200, await platformRoleService.updateRole(params.roleId, body, editorOf(req)), "Platform role updated");
}

async function changeRoleStatus(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, changePlatformRoleStatusRequest);
  const role = await platformRoleService.changeRoleStatus(params.roleId, body.is_active, editorOf(req));
  sendSuccess(res, 200, role, body.is_active ? "Platform role switched on" : "Platform role switched off");
}

async function listStaff(req: Request, res: Response): Promise<void> {
  const { query } = getValidated(req, listPlatformStaffRequest);
  const { rows, count } = await platformStaffService.list(query);
  sendList(res, 200, rows, { count, page: query.page, pageSize: query.pageSize }, "Platform staff retrieved");
}

async function getStaff(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, getPlatformStaffRequest);
  sendSuccess(res, 200, await platformStaffService.get(params.assignmentId), "Platform staff assignment retrieved");
}

/** 201 when given (new or reactivated), 200 when the person already had this platform role. */
async function assignStaff(req: Request, res: Response): Promise<void> {
  const { body } = getValidated(req, createPlatformStaffRequest);
  const { assignment, outcome, accountCreated } = await platformStaffService.assign(body, getActorId(req));
  const data = { ...assignment, account_created: accountCreated };
  if (outcome === "UNCHANGED") {
    sendSuccess(res, 200, data, "This person already has this platform role");
    return;
  }
  const done = outcome === "REACTIVATED" ? "Platform staff assignment reactivated" : "Platform staff assignment created";
  sendSuccess(res, 201, data, accountCreated ? `Cheche account created. ${done}` : done);
}

async function updateStaff(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, updatePlatformStaffRequest);
  sendSuccess(res, 200, await platformStaffService.update(params.assignmentId, body.role_id, getActorId(req)), "Platform staff assignment updated");
}

async function changeStaffStatus(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, changePlatformStaffStatusRequest);
  sendSuccess(res, 200, await platformStaffService.changeStatus(params.assignmentId, body.is_active, getActorId(req)), "Platform staff assignment status updated");
}

async function deleteStaff(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, deletePlatformStaffRequest);
  await platformStaffService.remove(params.assignmentId, getActorId(req));
  sendNoContent(res);
}

export const platformController = {
  listRoles,
  getRole,
  createRole,
  updateRole,
  changeRoleStatus,
  listStaff,
  getStaff,
  assignStaff,
  updateStaff,
  changeStaffStatus,
  deleteStaff,
};
