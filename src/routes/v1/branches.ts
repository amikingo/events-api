import { Router } from "express";
import { branchController } from "../../controllers/branch.controller.js";
import { requireStaffAuthentication } from "../../middleware/authentication.js";
import { organizationScopeFromParams, requirePermission } from "../../middleware/permission.js";
import { validate } from "../../middleware/validate.js";
import { MODULE_CODES } from "../../utils/module-codes.js";
import {
  changeBranchStatusRequest,
  createBranchRequest,
  getBranchRequest,
  listBranchesRequest,
  updateBranchRequest,
} from "../../validators/branch.js";

/** Mounted at /v1/organizations/:organizationId/branches (mergeParams exposes :organizationId). */
export const branchesRouter = Router({ mergeParams: true });

// Every route reads top to bottom: authenticate -> validate -> authorize -> controller.
branchesRouter.post(
  "/",
  requireStaffAuthentication,
  validate(createBranchRequest),
  requirePermission({ moduleCode: MODULE_CODES.BRANCHES, action: "create", scope: organizationScopeFromParams }),
  branchController.createBranch,
);

branchesRouter.get(
  "/",
  requireStaffAuthentication,
  validate(listBranchesRequest),
  requirePermission({ moduleCode: MODULE_CODES.BRANCHES, action: "view", scope: organizationScopeFromParams }),
  branchController.listBranches,
);

branchesRouter.get(
  "/:branchId",
  requireStaffAuthentication,
  validate(getBranchRequest),
  requirePermission({ moduleCode: MODULE_CODES.BRANCHES, action: "view", scope: organizationScopeFromParams }),
  branchController.getBranch,
);

branchesRouter.patch(
  "/:branchId",
  requireStaffAuthentication,
  validate(updateBranchRequest),
  requirePermission({ moduleCode: MODULE_CODES.BRANCHES, action: "update", scope: organizationScopeFromParams }),
  branchController.updateBranch,
);

branchesRouter.patch(
  "/:branchId/status",
  requireStaffAuthentication,
  validate(changeBranchStatusRequest),
  requirePermission({ moduleCode: MODULE_CODES.BRANCHES, action: "update", scope: organizationScopeFromParams }),
  branchController.changeBranchStatus,
);
