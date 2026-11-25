import { z } from "zod";
import type { RequestContract } from "../middleware/validate.js";
import { mobileSchema } from "./auth.js";
import { booleanQuerySchema, organizationIdParamsSchema, paginationQuerySchema, statusChangeSchema, uuidSchema } from "./common.js";

/**
 * Staff management (Phase 2b). A person is named by their mobile (09… or +251…), looked up in auth-cheche on the
 * server; a user_id from the browser is never trusted. `branch_id` limits the role to one branch (only when the
 * organization has branches).
 */
export const staffAssignmentCreateSchema = z.strictObject({
  mobile: mobileSchema,
  role_id: uuidSchema,
  branch_id: uuidSchema.optional(),
});

/** null branch_id makes the assignment organization-wide again. */
export const staffAssignmentUpdateSchema = z
  .strictObject({ role_id: uuidSchema.optional(), branch_id: uuidSchema.nullable().optional() })
  .refine((value) => value.role_id !== undefined || value.branch_id !== undefined, { message: "Provide role_id or branch_id" });

export const staffAssignmentParamsSchema = organizationIdParamsSchema.extend({ assignmentId: uuidSchema });

export const staffAssignmentListQuerySchema = paginationQuerySchema.extend({ is_active: booleanQuerySchema });

export const staffLookupQuerySchema = z.strictObject({ mobile: mobileSchema });

export type StaffAssignmentCreateInput = z.output<typeof staffAssignmentCreateSchema>;
export type StaffAssignmentUpdateInput = z.output<typeof staffAssignmentUpdateSchema>;
export type StaffAssignmentListQuery = z.output<typeof staffAssignmentListQuerySchema>;

// One contract per endpoint (see middleware/validate.ts).
export const lookUpStaffRequest = { params: organizationIdParamsSchema, query: staffLookupQuerySchema } satisfies RequestContract;

export const listStaffAssignmentsRequest = { params: organizationIdParamsSchema, query: staffAssignmentListQuerySchema } satisfies RequestContract;

export const createStaffAssignmentRequest = { params: organizationIdParamsSchema, body: staffAssignmentCreateSchema } satisfies RequestContract;

export const updateStaffAssignmentRequest = { params: staffAssignmentParamsSchema, body: staffAssignmentUpdateSchema } satisfies RequestContract;

export const changeStaffAssignmentStatusRequest = { params: staffAssignmentParamsSchema, body: statusChangeSchema } satisfies RequestContract;
