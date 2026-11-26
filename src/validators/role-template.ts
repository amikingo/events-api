import { z } from "zod";
import type { RequestContract } from "../middleware/validate.js";
import { codeSchema, nullableText, organizationIdParamsSchema, statusChangeSchema, uuidSchema } from "./common.js";
import { grantsSchema } from "./role.js";

/**
 * Role templates (Phase 2d): the platform's library of ready-made roles, edited by the Super Admin. Grants use the
 * role grant shape (view, create, update, and export on Guests); a left-out `export` means no. Which modules and
 * actions are allowed is checked by the service (TENANT_GRANTABLE). The code is fixed after creation.
 */
export const roleTemplateParamsSchema = z.strictObject({ templateId: uuidSchema });

export const roleTemplateCreateSchema = z.strictObject({
  code: codeSchema,
  name: z.string().trim().min(1).max(250),
  description: nullableText(2000),
  for_new_organizations: z.boolean().optional(),
  grants: grantsSchema,
});

export const roleTemplateUpdateSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(250).optional(),
    description: nullableText(2000),
    for_new_organizations: z.boolean().optional(),
    grants: grantsSchema.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), { message: "Provide at least one field to update" });

export type RoleTemplateCreateInput = z.output<typeof roleTemplateCreateSchema>;
export type RoleTemplateUpdateInput = z.output<typeof roleTemplateUpdateSchema>;

// One contract per endpoint (see middleware/validate.ts).
export const listRoleTemplatesRequest = {} satisfies RequestContract;
export const getRoleTemplateRequest = { params: roleTemplateParamsSchema } satisfies RequestContract;
export const createRoleTemplateRequest = { body: roleTemplateCreateSchema } satisfies RequestContract;
export const updateRoleTemplateRequest = { params: roleTemplateParamsSchema, body: roleTemplateUpdateSchema } satisfies RequestContract;
export const changeRoleTemplateStatusRequest = { params: roleTemplateParamsSchema, body: statusChangeSchema } satisfies RequestContract;
export const listOrganizationRoleTemplatesRequest = { params: organizationIdParamsSchema } satisfies RequestContract;
export const listTemplateRolesRequest = { params: roleTemplateParamsSchema } satisfies RequestContract;
