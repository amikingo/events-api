import { z } from "zod";
import type { RequestContract } from "../middleware/validate.js";
import { mobileSchema } from "./auth.js";
import { booleanQuerySchema, codeSchema, organizationIdParamsSchema, paginationQuerySchema, statusChangeSchema, uuidSchema } from "./common.js";

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

/** `role_id` lists the members of a role; `branch_id` the staff limited to one branch (Phase 2e). */
export const staffAssignmentListQuerySchema = paginationQuerySchema.extend({
  is_active: booleanQuerySchema,
  role_id: uuidSchema.optional(),
  branch_id: uuidSchema.optional(),
});

export const staffLookupQuerySchema = z.strictObject({ mobile: mobileSchema });

/**
 * Permission overrides (Phase 2d): per module, each box is true (allow), false (deny) or null / left out (follow the
 * role). Saving replaces the whole set; a module with every box null is removed. Which modules and actions may be
 * named is checked by the service (TENANT_GRANTABLE).
 */
const overrideValue = z.boolean().nullable().optional();
export const staffOverrideSchema = z.strictObject({
  module_code: codeSchema,
  view: overrideValue,
  create: overrideValue,
  update: overrideValue,
  delete: overrideValue,
  import: overrideValue,
  export: overrideValue,
  notify: overrideValue,
});

export const staffOverridesReplaceSchema = z.strictObject({
  overrides: z
    .array(staffOverrideSchema)
    .max(30)
    .superRefine((overrides, ctx) => {
      const seen = new Set<string>();
      overrides.forEach((override, index) => {
        if (seen.has(override.module_code)) ctx.addIssue({ code: "custom", path: [index, "module_code"], message: "Each module may appear only once" });
        seen.add(override.module_code);
      });
    }),
});

export type StaffOverrideInput = z.output<typeof staffOverrideSchema>;
export type StaffOverridesReplaceInput = z.output<typeof staffOverridesReplaceSchema>;

export type StaffAssignmentCreateInput = z.output<typeof staffAssignmentCreateSchema>;
export type StaffAssignmentUpdateInput = z.output<typeof staffAssignmentUpdateSchema>;
export type StaffAssignmentListQuery = z.output<typeof staffAssignmentListQuerySchema>;

// One contract per endpoint (see middleware/validate.ts).
export const lookUpStaffRequest = { params: organizationIdParamsSchema, query: staffLookupQuerySchema } satisfies RequestContract;

export const listStaffAssignmentsRequest = { params: organizationIdParamsSchema, query: staffAssignmentListQuerySchema } satisfies RequestContract;

export const createStaffAssignmentRequest = { params: organizationIdParamsSchema, body: staffAssignmentCreateSchema } satisfies RequestContract;

export const updateStaffAssignmentRequest = { params: staffAssignmentParamsSchema, body: staffAssignmentUpdateSchema } satisfies RequestContract;

export const changeStaffAssignmentStatusRequest = { params: staffAssignmentParamsSchema, body: statusChangeSchema } satisfies RequestContract;

export const getStaffAssignmentRequest = { params: staffAssignmentParamsSchema } satisfies RequestContract;

export const deleteStaffAssignmentRequest = { params: staffAssignmentParamsSchema } satisfies RequestContract;

export const listStaffOverridesRequest = { params: staffAssignmentParamsSchema } satisfies RequestContract;

export const replaceStaffOverridesRequest = { params: staffAssignmentParamsSchema, body: staffOverridesReplaceSchema } satisfies RequestContract;
