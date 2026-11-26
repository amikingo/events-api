import type { Request, Response } from "express";
import { getValidated } from "../middleware/validate.js";
import { staffAssignmentService } from "../services/staff-assignment.service.js";
import { sendList, sendNoContent, sendSuccess } from "../utils/http.js";
import {
  changeStaffAssignmentStatusRequest,
  createStaffAssignmentRequest,
  deleteStaffAssignmentRequest,
  getStaffAssignmentRequest,
  listStaffAssignmentsRequest,
  listStaffOverridesRequest,
  lookUpStaffRequest,
  replaceStaffOverridesRequest,
  updateStaffAssignmentRequest,
  updateStaffProfileRequest,
} from "../validators/staff-assignment.js";
import { getActorId, getStaffAuth } from "./helpers.js";

async function lookUp(req: Request, res: Response): Promise<void> {
  const { query } = getValidated(req, lookUpStaffRequest);
  sendSuccess(res, 200, await staffAssignmentService.lookUp(query.mobile), "Account found");
}

async function list(req: Request, res: Response): Promise<void> {
  const { params, query } = getValidated(req, listStaffAssignmentsRequest);
  const { rows, count } = await staffAssignmentService.list(params.organizationId, query);
  sendList(res, 200, rows, { count, page: query.page, pageSize: query.pageSize }, "Staff assignments retrieved");
}

async function get(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, getStaffAssignmentRequest);
  sendSuccess(res, 200, await staffAssignmentService.get(params.organizationId, params.assignmentId), "Staff assignment retrieved");
}

/** 201 when the person was given the role (new or reactivated); 200 when they already had it. */
async function assign(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, createStaffAssignmentRequest);
  const { assignment, outcome, accountCreated } = await staffAssignmentService.assign(params.organizationId, body, getActorId(req));
  const data = { ...assignment, account_created: accountCreated };
  if (outcome === "UNCHANGED") {
    sendSuccess(res, 200, data, "This person already has this role");
    return;
  }
  const done = outcome === "REACTIVATED" ? "Staff assignment reactivated" : "Staff assignment created";
  sendSuccess(res, 201, data, accountCreated ? `Cheche account created. ${done}` : done);
}

/** When the role changed and the person still has permission overrides, the message says so (Phase 2d). */
async function update(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, updateStaffAssignmentRequest);
  const assignment = await staffAssignmentService.update(params.organizationId, params.assignmentId, body, getActorId(req));
  const { override_count: count } = assignment;
  const message =
    assignment.role_changed && count > 0
      ? `Role changed. This person still has ${count} permission override${count === 1 ? "" : "s"}: review them.`
      : "Staff assignment updated";
  sendSuccess(res, 200, assignment, message);
}

/** Changes the person's names in auth-cheche (names only). */
async function updateProfile(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, updateStaffProfileRequest);
  sendSuccess(res, 200, await staffAssignmentService.updateProfile(params.organizationId, params.assignmentId, body), "Staff names updated");
}

/** 204: the assignment and its overrides are gone. */
async function remove(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, deleteStaffAssignmentRequest);
  await staffAssignmentService.remove(params.organizationId, params.assignmentId, getActorId(req));
  sendNoContent(res);
}

async function listOverrides(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, listStaffOverridesRequest);
  sendSuccess(res, 200, await staffAssignmentService.listOverrides(params.organizationId, params.assignmentId), "Permission overrides retrieved");
}

/** Replaces the whole override set. The editor's signed-in assignment decides what they may allow. */
async function replaceOverrides(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, replaceStaffOverridesRequest);
  const auth = getStaffAuth(req);
  const overrides = await staffAssignmentService.replaceOverrides(params.organizationId, params.assignmentId, body, {
    userId: auth.userId,
    assignmentId: auth.assignmentId,
  });
  sendSuccess(res, 200, overrides, "Permission overrides saved");
}

async function changeStatus(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, changeStaffAssignmentStatusRequest);
  const assignment = await staffAssignmentService.changeStatus(params.organizationId, params.assignmentId, body.is_active, getActorId(req));
  sendSuccess(res, 200, assignment, "Staff assignment status updated");
}

export const staffAssignmentController = { lookUp, list, get, assign, updateProfile, update, changeStatus, remove, listOverrides, replaceOverrides };
