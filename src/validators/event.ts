import { z } from "zod";
import type { RequestContract } from "../middleware/validate.js";
import type { EventStatus, EventVisibility, HolderFieldSetting, RegistrationMode } from "../models/event.js";
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

/** Phase 7: how each holder detail is asked for in a DETAILED event. All five are sent together. */
const holderFieldSetting = z.enum(["REQUIRED", "OPTIONAL", "HIDDEN"] as const satisfies readonly HolderFieldSetting[]);
const holderFieldsSchema = z
  .strictObject({
    name: holderFieldSetting,
    mobile: holderFieldSetting,
    email: holderFieldSetting,
    affiliation: holderFieldSetting,
    country: holderFieldSetting,
  })
  // A holder's details are kept on their guest profile, which needs a name: with the name hidden, nothing else can
  // be collected (that is an unnamed ticket, as in QUICK mode).
  .superRefine((value, ctx) => {
    if (value.name !== "HIDDEN") return;
    for (const key of ["mobile", "email", "affiliation", "country"] as const) {
      if (value[key] !== "HIDDEN") ctx.addIssue({ code: "custom", path: [key], message: "With the name hidden, this can't be collected either" });
    }
  });
/** Phase 7: most tickets one buyer mobile may hold at the event, across every order; null means no limit. */
const purchaseLimitSchema = z.number().int().positive().max(10_000).nullable().optional();

type Schedule = {
  starts_at?: Date | null | undefined;
  ends_at?: Date | null | undefined;
  doors_open_at?: Date | null | undefined;
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
  if (value.doors_open_at && value.ends_at && value.doors_open_at >= value.ends_at) {
    ctx.addIssue({ code: "custom", path: ["doors_open_at"], message: "doors_open_at must be before ends_at" });
  }
}

const eventFields = {
  slug: slugSchema.optional(),
  description: nullableText(10_000),
  starts_at: optionalInstant,
  ends_at: optionalInstant,
  /** Phase 9: when admission starts; null or left out means at starts_at. Admission ends at ends_at. */
  doors_open_at: optionalInstant,
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
  /** Phase 7. Default DETAILED with today's form (name and mobile required, the rest optional). */
  registration_mode: z.enum(["QUICK", "DETAILED"] as const satisfies readonly RegistrationMode[]).optional(),
  holder_fields: holderFieldsSchema.optional(),
  purchase_limit_per_mobile: purchaseLimitSchema,
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

/**
 * Phase 9: CANCELLED goes through the same rules as POST …/cancel, so it may carry the organizer's decision about used
 * tickets (required when the event already admitted guests).
 */
export const eventStatusChangeSchema = z.strictObject({ status: targetStatusSchema, refund_admitted_tickets: z.boolean().optional() });

/** Phase 9: cancel the whole event. refund_admitted_tickets is required when guests were already admitted. */
export const eventCancelSchema = z.strictObject({ refund_admitted_tickets: z.boolean().optional() });

/**
 * Phase 9: move a published event before its first admission. starts_at and ends_at are saved together;
 * doors_open_at must be sent again (kept, changed or null) when the event has one set.
 */
export const eventRescheduleSchema = z
  .strictObject({ starts_at: dateTimeSchema, ends_at: dateTimeSchema, doors_open_at: dateTimeSchema.nullable().optional() })
  .superRefine(checkScheduleOrder);

export const eventParamsSchema = organizationIdParamsSchema.extend({ eventId: uuidSchema });

export const eventListQuerySchema = paginationQuerySchema.extend({
  status: statusSchema.optional(),
  visibility: visibilitySchema.optional(),
});

export type EventCreateInput = z.output<typeof eventCreateSchema>;
export type EventUpdateInput = z.output<typeof eventUpdateSchema>;
export type EventListQuery = z.output<typeof eventListQuerySchema>;
export type EventTargetStatus = z.output<typeof targetStatusSchema>;
export type EventCancelInput = z.output<typeof eventCancelSchema>;
export type EventRescheduleInput = z.output<typeof eventRescheduleSchema>;

// One contract per endpoint (see middleware/validate.ts).
export const createEventRequest = { params: organizationIdParamsSchema, body: eventCreateSchema } satisfies RequestContract;

export const listEventsRequest = { params: organizationIdParamsSchema, query: eventListQuerySchema } satisfies RequestContract;

export const getEventRequest = { params: eventParamsSchema } satisfies RequestContract;

export const updateEventRequest = { params: eventParamsSchema, body: eventUpdateSchema } satisfies RequestContract;

export const changeEventStatusRequest = { params: eventParamsSchema, body: eventStatusChangeSchema } satisfies RequestContract;

export const cancelEventRequest = { params: eventParamsSchema, body: eventCancelSchema } satisfies RequestContract;

export const rescheduleEventRequest = { params: eventParamsSchema, body: eventRescheduleSchema } satisfies RequestContract;

/** The image itself arrives as multipart/form-data (field "file"), parsed by middleware/upload.ts after authorization. */
export const setEventCoverRequest = { params: eventParamsSchema } satisfies RequestContract;

export const removeEventCoverRequest = { params: eventParamsSchema } satisfies RequestContract;
