import { z } from "zod";
import type { RequestContract } from "../middleware/validate.js";
import { codeSchema, nullableText, organizationIdParamsSchema, statusChangeSchema, uuidSchema } from "./common.js";

export const roleParamsSchema = organizationIdParamsSchema.extend({ roleId: uuidSchema });

/**
 * One module's access in a role. Only view, create and update exist in the app; which modules and actions a tenant
 * role may get is checked by the service (utils/rbac.ts TENANT_GRANTABLE).
 */
export const roleGrantSchema = z.strictObject({
  module_code: codeSchema,
  view: z.boolean(),
  create: z.boolean(),
  update: z.boolean(),
});

const grantsSchema = z
  .array(roleGrantSchema)
  .max(30)
  .superRefine((grants, ctx) => {
    const seen = new Set<string>();
    grants.forEach((grant, index) => {
      if (seen.has(grant.module_code)) ctx.addIssue({ code: "custom", path: [index, "module_code"], message: "Each module may appear only once" });
      seen.add(grant.module_code);
    });
  });

/** A new role of this organization. The code is fixed afterwards (assignments and scripts use it). */
export const roleCreateSchema = z.strictObject({
  code: codeSchema,
  name: z.string().trim().min(1).max(250),
  description: nullableText(2000),
  grants: grantsSchema,
});

/** `grants` replaces the role's whole grant set; leave it out to keep the grants as they are. */
export const roleUpdateSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(250).optional(),
    description: nullableText(2000),
    grants: grantsSchema.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), { message: "Provide at least one field to update" });

export type RoleGrantInput = z.output<typeof roleGrantSchema>;
export type RoleCreateInput = z.output<typeof roleCreateSchema>;
export type RoleUpdateInput = z.output<typeof roleUpdateSchema>;

// One contract per endpoint (see middleware/validate.ts).
export const listRolesRequest = { params: organizationIdParamsSchema } satisfies RequestContract;

export const getRoleRequest = { params: roleParamsSchema } satisfies RequestContract;

export const createRoleRequest = { params: organizationIdParamsSchema, body: roleCreateSchema } satisfies RequestContract;

export const updateRoleRequest = { params: roleParamsSchema, body: roleUpdateSchema } satisfies RequestContract;

export const changeRoleStatusRequest = { params: roleParamsSchema, body: statusChangeSchema } satisfies RequestContract;
