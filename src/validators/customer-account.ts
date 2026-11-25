import { z } from "zod";
import type { RequestContract } from "../middleware/validate.js";
import type { CustomerAccountKind } from "../models/customer-account.js";
import {
  booleanQuerySchema,
  contactEmailSchema,
  contactPhoneSchema,
  nullableText,
  organizationIdParamsSchema,
  paginationQuerySchema,
  statusChangeSchema,
  uuidSchema,
} from "./common.js";

const kindSchema = z.enum(["ORGANIZATION", "INDIVIDUAL"] as const satisfies readonly CustomerAccountKind[]);

const INDIVIDUAL_TYPE_MESSAGE = "type describes an organization's sector; leave it empty for an individual";

export const customerAccountCreateSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(255),
    /** Defaults to ORGANIZATION. */
    kind: kindSchema.optional(),
    /** An organizational client's sector, e.g. Corporate, NGO, Government. Free text for now. */
    type: nullableText(80),
    primary_contact_name: nullableText(255),
    primary_contact_email: contactEmailSchema,
    primary_contact_phone: contactPhoneSchema,
    is_active: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.kind ?? "ORGANIZATION") === "INDIVIDUAL" && typeof value.type === "string") {
      ctx.addIssue({ code: "custom", path: ["type"], message: INDIVIDUAL_TYPE_MESSAGE });
    }
  });

export const customerAccountUpdateSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(255).optional(),
    kind: kindSchema.optional(),
    type: nullableText(80),
    primary_contact_name: nullableText(255),
    primary_contact_email: contactEmailSchema,
    primary_contact_phone: contactPhoneSchema,
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "Provide at least one field to update",
  })
  .superRefine((value, ctx) => {
    // The stored values are checked in the service; this catches a contradiction inside one request.
    if (value.kind === "INDIVIDUAL" && typeof value.type === "string") {
      ctx.addIssue({ code: "custom", path: ["type"], message: INDIVIDUAL_TYPE_MESSAGE });
    }
  });

export const customerAccountParamsSchema = organizationIdParamsSchema.extend({ customerAccountId: uuidSchema });

export const customerAccountListQuerySchema = paginationQuerySchema.extend({ is_active: booleanQuerySchema });

export type CustomerAccountCreateInput = z.output<typeof customerAccountCreateSchema>;
export type CustomerAccountUpdateInput = z.output<typeof customerAccountUpdateSchema>;
export type CustomerAccountListQuery = z.output<typeof customerAccountListQuerySchema>;

// One contract per endpoint (see middleware/validate.ts).
export const createCustomerAccountRequest = {
  params: organizationIdParamsSchema,
  body: customerAccountCreateSchema,
} satisfies RequestContract;

export const listCustomerAccountsRequest = {
  params: organizationIdParamsSchema,
  query: customerAccountListQuerySchema,
} satisfies RequestContract;

export const getCustomerAccountRequest = { params: customerAccountParamsSchema } satisfies RequestContract;

export const updateCustomerAccountRequest = {
  params: customerAccountParamsSchema,
  body: customerAccountUpdateSchema,
} satisfies RequestContract;

export const changeCustomerAccountStatusRequest = {
  params: customerAccountParamsSchema,
  body: statusChangeSchema,
} satisfies RequestContract;
