import { z } from "zod";
import type { RequestContract } from "../middleware/validate.js";
import { nullableText, uuidSchema } from "./common.js";

/**
 * Modules (Phase 2d): the Super Admin edits display fields only. Codes, routes, parents and on/off stay fixed: the
 * code and the web app depend on them, and switching a module off would lock everyone out of it. The icon is a
 * Lucide icon name; the web app falls back to a default when it doesn't know it.
 */
export const moduleParamsSchema = z.strictObject({ moduleId: uuidSchema });

export const moduleUpdateSchema = z
  .strictObject({
    module_name: z.string().trim().min(1).max(250).optional(),
    description: nullableText(2000),
    sno: z.number().int().min(0).max(10_000).optional(),
    icon: z
      .string()
      .trim()
      .regex(/^[A-Za-z][A-Za-z0-9]{0,59}$/, "An icon name: letters and digits, starting with a letter, up to 60")
      .nullable()
      .optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), { message: "Provide at least one field to update" });

export type ModuleUpdateInput = z.output<typeof moduleUpdateSchema>;

// One contract per endpoint (see middleware/validate.ts).
export const listModulesRequest = {} satisfies RequestContract;
export const updateModuleRequest = { params: moduleParamsSchema, body: moduleUpdateSchema } satisfies RequestContract;
