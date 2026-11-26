import { z } from "zod";
import type { RequestContract } from "../middleware/validate.js";
import { mobileSchema } from "./auth.js";
import { booleanQuerySchema, codeSchema, nullableText, paginationQuerySchema, statusChangeSchema, uuidSchema } from "./common.js";
import { grantsSchema } from "./role.js";
import { newStaffAccountSchema } from "./staff-assignment.js";

/**
 * Platform roles and platform staff (Phase 2e): no organization in the path; platform scope only. Grants use the role
 * grant shape (all 7 actions); which modules exist is checked by the service. Codes are fixed after creation.
 */
export const platformRoleParamsSchema = z.strictObject({ roleId: uuidSchema });
export const platformStaffParamsSchema = z.strictObject({ assignmentId: uuidSchema });

export const platformRoleCreateSchema = z.strictObject({
  code: codeSchema,
  name: z.string().trim().min(1).max(250),
  description: nullableText(2000),
  grants: grantsSchema,
});

export const platformRoleUpdateSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(250).optional(),
    description: nullableText(2000),
    grants: grantsSchema.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), { message: "Provide at least one field to update" });

/** A platform role for the person behind a mobile; `new_account` creates their Cheche account when there is none. */
export const platformStaffCreateSchema = z.strictObject({
  mobile: mobileSchema,
  role_id: uuidSchema,
  new_account: newStaffAccountSchema.optional(),
});

export const platformStaffUpdateSchema = z.strictObject({ role_id: uuidSchema });

export const platformStaffListQuerySchema = paginationQuerySchema.extend({ is_active: booleanQuerySchema, role_id: uuidSchema.optional() });

export type PlatformRoleCreateInput = z.output<typeof platformRoleCreateSchema>;
export type PlatformRoleUpdateInput = z.output<typeof platformRoleUpdateSchema>;
export type PlatformStaffCreateInput = z.output<typeof platformStaffCreateSchema>;
export type PlatformStaffListQuery = z.output<typeof platformStaffListQuerySchema>;

// One contract per endpoint (see middleware/validate.ts).
export const listPlatformRolesRequest = {} satisfies RequestContract;
export const getPlatformRoleRequest = { params: platformRoleParamsSchema } satisfies RequestContract;
export const createPlatformRoleRequest = { body: platformRoleCreateSchema } satisfies RequestContract;
export const updatePlatformRoleRequest = { params: platformRoleParamsSchema, body: platformRoleUpdateSchema } satisfies RequestContract;
export const changePlatformRoleStatusRequest = { params: platformRoleParamsSchema, body: statusChangeSchema } satisfies RequestContract;

export const listPlatformStaffRequest = { query: platformStaffListQuerySchema } satisfies RequestContract;
export const getPlatformStaffRequest = { params: platformStaffParamsSchema } satisfies RequestContract;
export const createPlatformStaffRequest = { body: platformStaffCreateSchema } satisfies RequestContract;
export const updatePlatformStaffRequest = { params: platformStaffParamsSchema, body: platformStaffUpdateSchema } satisfies RequestContract;
export const changePlatformStaffStatusRequest = { params: platformStaffParamsSchema, body: statusChangeSchema } satisfies RequestContract;
export const deletePlatformStaffRequest = { params: platformStaffParamsSchema } satisfies RequestContract;
