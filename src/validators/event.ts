import { z } from "zod";
import type { RequestContract } from "../middleware/validate.js";
import type { EventStatus, EventVisibility } from "../models/event.js";
import { dateTimeSchema, nullableText, organizationIdParamsSchema, paginationQuerySchema, timeZoneSchema, uuidSchema } from "./common.js";
import { slugSchema } from "./organization.js";

const visibilitySchema = z.enum(["PUBLIC", "UNLISTED"] as const satisfies readonly EventVisibility[]);
const statusSchema = z.enum(["DRAFT", "PUBLISHED", "CLOSED", "CANCELLED"] as const satisfies readonly EventStatus[]);
/** Status changes go through PATCH …/status; DRAFT is never a target (no return to draft). */
const targetStatusSchema = z.enum(["PUBLISHED", "CLOSED", "CANCELLED"] as const satisfies readonly EventStatus[]);

/** An instant with an explicit offset or Z; null clears it. */
const optionalInstant = dateTimeSchema.nullable().optional();
/** An optional link to a row of the same organization (checked by the service and by composite foreign keys). */
const optionalLink = uuidSchema.nullable().optional();
/** Optional booking limit; null means no event-wide limit. */
const capacitySchema = z.number().int().positive().max(1_000_000).nullable().optional();

type Schedule = {
  starts_at?: Date | null | undefined;
  ends_at?: Date | null | undefined;
  registration_opens_at?: Date | null | undefined;
  registration_closes_at?: Date | null | undefined;
};

/** Order checks inside one request; the service repeats them on the stored values merged with the change. */
function checkScheduleOrder(value: Schedule, ctx: z.RefinementCtx): void {
  if (value.starts_at && value.ends_at && value.starts_at >= value.ends_at) {
    ctx.addIssue({ code: "custom", path: ["ends_at"], message: "ends_at must be after starts_at" });
  }
  if (value.registration_opens_at && value.registration_closes_at && value.registration_opens_at >= value.registration_closes_at) {
    ctx.addIssue({ code: "custom", path: ["registration_closes_at"], message: "registration_closes_at must be after registration_opens_at" });
  }
}

const eventFields = {
  slug: slugSchema.optional(),
  description: nullableText(10_000),
  starts_at: optionalInstant,
  ends_at: optionalInstant,
  /** Default: the organization's timezone, copied once. */
  timezone: timeZoneSchema.optional(),
  capacity: capacitySchema,
  registration_opens_at: optionalInstant,
  registration_closes_at: optionalInstant,
  visibility: visibilitySchema.optional(),
  /** Free text for this phase (a category table comes later). */
  category: nullableText(80),
  /** NULL means organization-wide, even when a default branch exists. */
  branch_id: optionalLink,
  customer_account_id: optionalLink,
  venue_id: optionalLink,
  cover_file_id: optionalLink,
};

/** New events start as DRAFT with visibility UNLISTED unless PUBLIC is chosen; General Admission is added. */
export const eventCreateSchema = z
  .strictObject({ name: z.string().trim().min(1).max(255), ...eventFields })
  .superRefine(checkScheduleOrder);

export const eventUpdateSchema = z
  .strictObject({ name: z.string().trim().min(1).max(255).optional(), ...eventFields })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "Provide at least one field to update",
  })
  .superRefine(checkScheduleOrder);

export const eventStatusChangeSchema = z.strictObject({ status: targetStatusSchema });

export const eventParamsSchema = organizationIdParamsSchema.extend({ eventId: uuidSchema });

export const eventListQuerySchema = paginationQuerySchema.extend({
  status: statusSchema.optional(),
  visibility: visibilitySchema.optional(),
});

export type EventCreateInput = z.output<typeof eventCreateSchema>;
export type EventUpdateInput = z.output<typeof eventUpdateSchema>;
export type EventListQuery = z.output<typeof eventListQuerySchema>;
export type EventTargetStatus = z.output<typeof targetStatusSchema>;

// One contract per endpoint (see middleware/validate.ts).
export const createEventRequest = { params: organizationIdParamsSchema, body: eventCreateSchema } satisfies RequestContract;

export const listEventsRequest = { params: organizationIdParamsSchema, query: eventListQuerySchema } satisfies RequestContract;

export const getEventRequest = { params: eventParamsSchema } satisfies RequestContract;

export const updateEventRequest = { params: eventParamsSchema, body: eventUpdateSchema } satisfies RequestContract;

export const changeEventStatusRequest = { params: eventParamsSchema, body: eventStatusChangeSchema } satisfies RequestContract;

/** The image itself arrives as multipart/form-data (field "file"), parsed by middleware/upload.ts after authorization. */
export const setEventCoverRequest = { params: eventParamsSchema } satisfies RequestContract;

export const removeEventCoverRequest = { params: eventParamsSchema } satisfies RequestContract;
