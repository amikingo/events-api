import { z } from "zod";
import type { RequestContract } from "../middleware/validate.js";
import { booleanQuerySchema, codeSchema, nullableText, organizationIdParamsSchema, paginationQuerySchema } from "./common.js";

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase words separated by single hyphens");

export const organizationCreateSchema = z.strictObject({
  organization: z.strictObject({
    name: z.string().trim().min(1).max(255),
    slug: slugSchema.optional(),
    description: nullableText(4000),
    /** Default false: a hidden MAIN branch is created and staff never see branches. */
    has_branches: z.boolean().optional(),
  }),
  default_branch: z
    .strictObject({
      code: codeSchema,
      name: z.string().trim().min(1).max(255),
    })
    .optional(),
});

export const organizationListQuerySchema = paginationQuerySchema.extend({ is_active: booleanQuerySchema });

export type OrganizationCreateInput = z.output<typeof organizationCreateSchema>;
export type OrganizationListQuery = z.output<typeof organizationListQuerySchema>;

export const createOrganizationRequest = { body: organizationCreateSchema } satisfies RequestContract;
export const listOrganizationsRequest = { query: organizationListQuerySchema } satisfies RequestContract;
export const getOrganizationRequest = { params: organizationIdParamsSchema } satisfies RequestContract;
