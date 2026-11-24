import { z } from "zod";
import type { RequestContract } from "../middleware/validate.js";
import {
  booleanQuerySchema,
  codeSchema,
  countryCodeSchema,
  currencyCodeSchema,
  nullableText,
  organizationIdParamsSchema,
  paginationQuerySchema,
  timeZoneSchema,
} from "./common.js";

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
    /** Defaults ET, Africa/Addis_Ababa and ETB (the Ethiopian pilot); editable later. */
    country: countryCodeSchema.optional(),
    timezone: timeZoneSchema.optional(),
    default_currency: currencyCodeSchema.optional(),
  }),
  default_branch: z
    .strictObject({
      code: codeSchema,
      name: z.string().trim().min(1).max(255),
    })
    .optional(),
});

export const organizationListQuerySchema = paginationQuerySchema.extend({ is_active: booleanQuerySchema });

/** The organization's defaults only. Changing timezone never changes existing events. */
export const organizationSettingsUpdateSchema = z
  .strictObject({
    country: countryCodeSchema.optional(),
    timezone: timeZoneSchema.optional(),
    default_currency: currencyCodeSchema.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "Provide at least one field to update",
  });

export type OrganizationCreateInput = z.output<typeof organizationCreateSchema>;
export type OrganizationListQuery = z.output<typeof organizationListQuerySchema>;
export type OrganizationSettingsUpdateInput = z.output<typeof organizationSettingsUpdateSchema>;

export const createOrganizationRequest = { body: organizationCreateSchema } satisfies RequestContract;
export const listOrganizationsRequest = { query: organizationListQuerySchema } satisfies RequestContract;
export const getOrganizationRequest = { params: organizationIdParamsSchema } satisfies RequestContract;
export const updateOrganizationSettingsRequest = {
  params: organizationIdParamsSchema,
  body: organizationSettingsUpdateSchema,
} satisfies RequestContract;
