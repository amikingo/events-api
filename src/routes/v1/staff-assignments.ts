import { Router } from "express";
import { staffAssignmentController } from "../../controllers/staff-assignment.controller.js";
import { requireStaffAuthentication } from "../../middleware/authentication.js";
import { organizationScopeFromParams, requirePermission } from "../../middleware/permission.js";
import { validate } from "../../middleware/validate.js";
import { MODULE_CODES } from "../../utils/module-codes.js";
import {
  changeStaffAssignmentStatusRequest,
  createStaffAssignmentRequest,
  listStaffAssignmentsRequest,
  lookUpStaffRequest,
  updateStaffAssignmentRequest,
} from "../../validators/staff-assignment.js";

/**
 * Mounted at /v1/organizations/:organizationId (mergeParams exposes :organizationId): staff assignments and the
 * auth-cheche lookup that precedes adding someone (Phase 2b, module USER_ROLES).
 */
export const staffAssignmentsRouter = Router({ mergeParams: true });

// Every route reads top to bottom: authenticate -> validate -> authorize -> controller.
staffAssignmentsRouter.get(
  "/staff-lookup",
  requireStaffAuthentication,
  validate(lookUpStaffRequest),
  requirePermission({ moduleCode: MODULE_CODES.USER_ROLES, action: "create", scope: organizationScopeFromParams }),
  staffAssignmentController.lookUp,
);

staffAssignmentsRouter.get(
  "/staff-assignments",
  requireStaffAuthentication,
  validate(listStaffAssignmentsRequest),
  requirePermission({ moduleCode: MODULE_CODES.USER_ROLES, action: "view", scope: organizationScopeFromParams }),
  staffAssignmentController.list,
);

staffAssignmentsRouter.post(
  "/staff-assignments",
  requireStaffAuthentication,
  validate(createStaffAssignmentRequest),
  requirePermission({ moduleCode: MODULE_CODES.USER_ROLES, action: "create", scope: organizationScopeFromParams }),
  staffAssignmentController.assign,
);

staffAssignmentsRouter.patch(
  "/staff-assignments/:assignmentId",
  requireStaffAuthentication,
  validate(updateStaffAssignmentRequest),
  requirePermission({ moduleCode: MODULE_CODES.USER_ROLES, action: "update", scope: organizationScopeFromParams }),
  staffAssignmentController.update,
);

staffAssignmentsRouter.patch(
  "/staff-assignments/:assignmentId/status",
  requireStaffAuthentication,
  validate(changeStaffAssignmentStatusRequest),
  requirePermission({ moduleCode: MODULE_CODES.USER_ROLES, action: "update", scope: organizationScopeFromParams }),
  staffAssignmentController.changeStatus,
);
