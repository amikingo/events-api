import { z } from "zod";
import { canonicalTimeZone } from "../utils/time-zone.js";

export const uuidSchema = z.uuid();

/** ISO 3166-1 alpha-2 country code, stored upper-case ("et" → "ET"). */
export const countryCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, "Use the two-letter country code, e.g. ET");

/** ISO 4217 currency code, stored upper-case ("etb" → "ETB"). */
export const currencyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "Use the three-letter currency code, e.g. ETB");

/** IANA time zone, stored in its canonical spelling (e.g. Africa/Addis_Ababa). */
export const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .transform((value, ctx) => {
    const canonical = canonicalTimeZone(value);
    if (!canonical) {
      ctx.addIssue({ code: "custom", message: "Use an IANA time zone, e.g. Africa/Addis_Ababa" });
      return z.NEVER;
    }
    return canonical;
  });

/** An instant with an explicit offset or Z (e.g. 2027-03-12T09:00:00+03:00); never a local time without one. */
export const dateTimeSchema = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

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
