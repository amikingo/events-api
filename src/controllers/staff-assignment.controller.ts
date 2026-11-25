import type { Request, Response } from "express";
import { getValidated } from "../middleware/validate.js";
import { staffAssignmentService } from "../services/staff-assignment.service.js";
import { sendList, sendSuccess } from "../utils/http.js";
import {
  changeStaffAssignmentStatusRequest,
  createStaffAssignmentRequest,
  listStaffAssignmentsRequest,
  lookUpStaffRequest,
  updateStaffAssignmentRequest,
} from "../validators/staff-assignment.js";
import { getActorId } from "./helpers.js";

async function lookUp(req: Request, res: Response): Promise<void> {
  const { query } = getValidated(req, lookUpStaffRequest);
  sendSuccess(res, 200, await staffAssignmentService.lookUp(query.mobile), "Account found");
}

async function list(req: Request, res: Response): Promise<void> {
  const { params, query } = getValidated(req, listStaffAssignmentsRequest);
  const { rows, count } = await staffAssignmentService.list(params.organizationId, query);
  sendList(res, 200, rows, { count, page: query.page, pageSize: query.pageSize }, "Staff assignments retrieved");
}

/** 201 when the person was given the role (new or reactivated); 200 when they already had it. */
async function assign(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, createStaffAssignmentRequest);
  const { assignment, outcome } = await staffAssignmentService.assign(params.organizationId, body, getActorId(req));
  if (outcome === "UNCHANGED") {
    sendSuccess(res, 200, assignment, "This person already has this role");
    return;
  }
  sendSuccess(res, 201, assignment, outcome === "REACTIVATED" ? "Staff assignment reactivated" : "Staff assignment created");
}

async function update(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, updateStaffAssignmentRequest);
  sendSuccess(res, 200, await staffAssignmentService.update(params.organizationId, params.assignmentId, body, getActorId(req)), "Staff assignment updated");
}

async function changeStatus(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, changeStaffAssignmentStatusRequest);
  const assignment = await staffAssignmentService.changeStatus(params.organizationId, params.assignmentId, body.is_active, getActorId(req));
  sendSuccess(res, 200, assignment, "Staff assignment status updated");
}

export const staffAssignmentController = { lookUp, list, assign, update, changeStatus };
