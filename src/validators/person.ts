import { z } from "zod";
import type { RequestContract } from "../middleware/validate.js";
import {
  booleanQuerySchema,
  contactEmailSchema,
  contactPhoneSchema,
  countryCodeSchema,
  nullableText,
  organizationIdParamsSchema,
  paginationQuerySchema,
  statusChangeSchema,
  uuidSchema,
} from "./common.js";

/**
 * A guest profile as staff enter it: only the first name is required. Phones follow the client rule (Ethiopian
 * mobiles stored as +251…, others as typed); a confirmation SMS is queued only for an Ethiopian mobile.
 */
export const personFields = {
  first_name: z.string().trim().min(1).max(100),
  last_name: nullableText(100),
  email: contactEmailSchema,
  phone: contactPhoneSchema,
  affiliation_name: nullableText(200),
  country: countryCodeSchema.nullable().optional(),
};

/** The profile fields of a new guest, also used inside a registration request. */
export const personInputSchema = z.strictObject(personFields);

export const personCreateSchema = z.strictObject({ ...personFields, is_active: z.boolean().optional() });

export const personUpdateSchema = z
  .strictObject({ ...personFields, first_name: personFields.first_name.optional() })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "Provide at least one field to update",
  });

export const personParamsSchema = organizationIdParamsSchema.extend({ personId: uuidSchema });

/** `q` searches names, email and phone (an Ethiopian mobile also matches its +251 form). */
export const searchTextSchema = z.string().trim().min(1).max(100).optional();

export const personListQuerySchema = paginationQuerySchema.extend({ q: searchTextSchema, is_active: booleanQuerySchema });

export type PersonInput = z.output<typeof personInputSchema>;
export type PersonCreateInput = z.output<typeof personCreateSchema>;
export type PersonUpdateInput = z.output<typeof personUpdateSchema>;
export type PersonListQuery = z.output<typeof personListQuerySchema>;

// One contract per endpoint (see middleware/validate.ts).
export const createPersonRequest = { params: organizationIdParamsSchema, body: personCreateSchema } satisfies RequestContract;

export const listPersonsRequest = { params: organizationIdParamsSchema, query: personListQuerySchema } satisfies RequestContract;

export const getPersonRequest = { params: personParamsSchema } satisfies RequestContract;

export const updatePersonRequest = { params: personParamsSchema, body: personUpdateSchema } satisfies RequestContract;

export const changePersonStatusRequest = { params: personParamsSchema, body: statusChangeSchema } satisfies RequestContract;
