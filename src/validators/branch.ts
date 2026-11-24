import { z } from "zod";
import type { RequestContract } from "../middleware/validate.js";
import {
  booleanQuerySchema,
  codeSchema,
  nullableText,
  organizationIdParamsSchema,
  paginationQuerySchema,
  statusChangeSchema,
  uuidSchema,
} from "./common.js";

export const branchCreateSchema = z.strictObject({
  code: codeSchema,
  name: z.string().trim().min(1).max(255),
  description: nullableText(4000),
  is_active: z.boolean().optional(),
  is_default: z.boolean().optional(),
});

export const branchUpdateSchema = z
  .strictObject({
    code: codeSchema.optional(),
    name: z.string().trim().min(1).max(255).optional(),
    description: nullableText(4000),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "Provide at least one field to update",
  });

export const branchParamsSchema = organizationIdParamsSchema.extend({ branchId: uuidSchema });

export const branchListQuerySchema = paginationQuerySchema.extend({ is_active: booleanQuerySchema });

export type BranchCreateInput = z.output<typeof branchCreateSchema>;
export type BranchUpdateInput = z.output<typeof branchUpdateSchema>;
export type BranchListQuery = z.output<typeof branchListQuerySchema>;

// One contract per endpoint (see middleware/validate.ts).
export const createBranchRequest = {
  params: organizationIdParamsSchema,
  body: branchCreateSchema,
} satisfies RequestContract;

export const listBranchesRequest = {
  params: organizationIdParamsSchema,
  query: branchListQuerySchema,
} satisfies RequestContract;

export const getBranchRequest = { params: branchParamsSchema } satisfies RequestContract;

export const updateBranchRequest = {
  params: branchParamsSchema,
  body: branchUpdateSchema,
} satisfies RequestContract;

export const changeBranchStatusRequest = {
  params: branchParamsSchema,
  body: statusChangeSchema,
} satisfies RequestContract;
