import { z } from "zod";
import type { RequestContract } from "../middleware/validate.js";
import { codeSchema, nullableText, statusChangeSchema, uuidSchema } from "./common.js";

/**
 * Modules (Phase 2d, extended in Phase 2e): the platform's menu and permission list, edited by the Super Admin.
 * - Display fields: name, description, order and icon. The icon is a Lucide icon name; the web app falls back to a
 *   default when it doesn't know it.
 * - Structure (Phase 2e): parent, route, menu flag and permission flag. Core modules (the ones the code checks) keep
 *   their route and permission flag; the service refuses those with 409 module_protected.
 * - Codes are fixed once created (upper case, unique).
 * - Switching on and off is its own endpoint.
 */
export const moduleParamsSchema = z.strictObject({ moduleId: uuidSchema });

const moduleNameSchema = z.string().trim().min(1).max(250);
const snoSchema = z.number().int().min(0).max(10_000);
const iconSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9]{0,59}$/, "An icon name: letters and digits, starting with a letter, up to 60")
  .nullable();
/** A web app path such as "/access/modules": starts with "/", then letters, digits, "-", "_" and "/" (up to 250). */
const routeNameSchema = z
  .string()
  .trim()
  .regex(/^\/[A-Za-z0-9\-_/]{0,249}$/, 'A path in the web app, starting with "/", e.g. /reports/sales')
  .nullable();

export const moduleCreateSchema = z.strictObject({
  code: codeSchema,
  module_name: moduleNameSchema,
  description: nullableText(2000),
  parent_id: uuidSchema.nullable().optional(),
  sno: snoSchema.optional(),
  icon: iconSchema.optional(),
  route_name: routeNameSchema.optional(),
  is_menu: z.boolean(),
  is_permission: z.boolean(),
});

export const moduleUpdateSchema = z
  .strictObject({
    module_name: moduleNameSchema.optional(),
    description: nullableText(2000),
    sno: snoSchema.optional(),
    icon: iconSchema.optional(),
    parent_id: uuidSchema.nullable().optional(),
    route_name: routeNameSchema.optional(),
    is_menu: z.boolean().optional(),
    is_permission: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), { message: "Provide at least one field to update" });

export type ModuleCreateInput = z.output<typeof moduleCreateSchema>;
export type ModuleUpdateInput = z.output<typeof moduleUpdateSchema>;

// One contract per endpoint (see middleware/validate.ts).
export const listModulesRequest = {} satisfies RequestContract;
export const createModuleRequest = { body: moduleCreateSchema } satisfies RequestContract;
export const updateModuleRequest = { params: moduleParamsSchema, body: moduleUpdateSchema } satisfies RequestContract;
export const changeModuleStatusRequest = { params: moduleParamsSchema, body: statusChangeSchema } satisfies RequestContract;
