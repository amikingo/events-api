import { z } from "zod";

export const uuidSchema = z.uuid();

/** UPPER_SNAKE_CASE business codes (branch codes, role codes, module codes). */
export const codeSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9_]+$/, "Code may contain only letters, digits and underscores"));

/** Optional nullable text: omitted => undefined (keep), null or "" => null (clear). */
export function nullableText(maxLength: number) {
  return z
    .string()
    .trim()
    .max(maxLength)
    .nullable()
    .optional()
    .transform((value) => (value === "" ? null : value));
}

/** Money/decimal as a string to keep precision end to end (Postgres NUMERIC comes back as string). */
export const decimalStringSchema = z
  .string()
  .trim()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/, "Expected a decimal with at most 2 fraction digits");

export const paginationQuerySchema = z.strictObject({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

/** Query-string booleans are only "true" | "false" (never z.coerce.boolean: "false" would be true). */
export const booleanQuerySchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true")
  .optional();

export const statusChangeSchema = z.strictObject({ is_active: z.boolean() });

export const organizationIdParamsSchema = z.strictObject({ organizationId: uuidSchema });
