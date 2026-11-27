import { Router } from "express";
import { staffAssignmentController } from "../../controllers/staff-assignment.controller.js";
import { requireStaffAuthentication } from "../../middleware/authentication.js";
import { organizationScopeFromParams, requirePermission } from "../../middleware/permission.js";
import { validate } from "../../middleware/validate.js";
import { MODULE_CODES } from "../../utils/module-codes.js";
import {
  changeStaffAssignmentStatusRequest,
  createStaffAssignmentRequest,
  deleteStaffAssignmentRequest,
  getStaffAssignmentRequest,
  getStaffProfileRequest,
  listStaffAssignmentsRequest,
  listStaffOverridesRequest,
  lookUpStaffRequest,
  replaceStaffOverridesRequest,
  updateStaffAssignmentRequest,
  updateStaffProfileRequest,
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

staffAssignmentsRouter.get(
  "/staff-assignments/:assignmentId",
  requireStaffAuthentication,
  validate(getStaffAssignmentRequest),
  requirePermission({ moduleCode: MODULE_CODES.USER_ROLES, action: "view", scope: organizationScopeFromParams }),
  staffAssignmentController.get,
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

// Phase 10: the person's editable profile in auth-cheche (names, email, sex, date of birth).
staffAssignmentsRouter.get(
  "/staff-assignments/:assignmentId/profile",
  requireStaffAuthentication,
  validate(getStaffProfileRequest),
  requirePermission({ moduleCode: MODULE_CODES.USER_ROLES, action: "view", scope: organizationScopeFromParams }),
  staffAssignmentController.getProfile,
);

// Phase 10 (Phase 2e names, extended): names, email, sex and date of birth in auth-cheche, only what changed; never
// mobile, status, PIN or password.
staffAssignmentsRouter.patch(
  "/staff-assignments/:assignmentId/profile",
  requireStaffAuthentication,
  validate(updateStaffProfileRequest),
  requirePermission({ moduleCode: MODULE_CODES.USER_ROLES, action: "update", scope: organizationScopeFromParams }),
  staffAssignmentController.updateProfile,
);

// Phase 2e: delete for good (any assignment but the last active Owner, never your own); overrides go with it.
staffAssignmentsRouter.delete(
  "/staff-assignments/:assignmentId",
  requireStaffAuthentication,
  validate(deleteStaffAssignmentRequest),
  requirePermission({ moduleCode: MODULE_CODES.USER_ROLES, action: "delete", scope: organizationScopeFromParams }),
  staffAssignmentController.remove,
);

// Permission overrides (Phase 2d): one staff member's access, module by module, on top of their role.
staffAssignmentsRouter.get(
  "/staff-assignments/:assignmentId/overrides",
  requireStaffAuthentication,
  validate(listStaffOverridesRequest),
  requirePermission({ moduleCode: MODULE_CODES.USER_ROLES, action: "view", scope: organizationScopeFromParams }),
  staffAssignmentController.listOverrides,
);

staffAssignmentsRouter.put(
  "/staff-assignments/:assignmentId/overrides",
  requireStaffAuthentication,
  validate(replaceStaffOverridesRequest),
  requirePermission({ moduleCode: MODULE_CODES.USER_ROLES, action: "update", scope: organizationScopeFromParams }),
  staffAssignmentController.replaceOverrides,
);
