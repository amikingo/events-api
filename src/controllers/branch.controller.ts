import type { Request, Response } from "express";
import { branchService } from "../services/branch.service.js";
import { sendList, sendSuccess } from "../utils/http.js";
import {
  changeBranchStatusRequest,
  createBranchRequest,
  getBranchRequest,
  listBranchesRequest,
  updateBranchRequest,
} from "../validators/branch.js";
import { getValidated } from "../middleware/validate.js";
import { getActorId } from "./helpers.js";

async function createBranch(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, createBranchRequest);
  const branch = await branchService.createBranch(params.organizationId, body, getActorId(req));
  sendSuccess(res, 201, branch, "Branch created");
}

async function listBranches(req: Request, res: Response): Promise<void> {
  const { params, query } = getValidated(req, listBranchesRequest);
  const { rows, count } = await branchService.listBranches(params.organizationId, query);
  sendList(res, 200, rows, { count, page: query.page, pageSize: query.pageSize }, "Branches retrieved");
}

async function getBranch(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, getBranchRequest);
  const branch = await branchService.getBranch(params.organizationId, params.branchId);
  sendSuccess(res, 200, branch, "Branch retrieved");
}

async function updateBranch(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, updateBranchRequest);
  const branch = await branchService.updateBranch(params.organizationId, params.branchId, body, getActorId(req));
  sendSuccess(res, 200, branch, "Branch updated");
}

async function changeBranchStatus(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, changeBranchStatusRequest);
  const branch = await branchService.changeBranchStatus(params.organizationId, params.branchId, body.is_active, getActorId(req));
  sendSuccess(res, 200, branch, "Branch status updated");
}

export const branchController = { createBranch, listBranches, getBranch, updateBranch, changeBranchStatus };
