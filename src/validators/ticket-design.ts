import { z } from "zod";
import type { RequestContract } from "../middleware/validate.js";
import type { TicketQrSize } from "../models/event-ticket-design.js";
import { nullableText, organizationIdParamsSchema, uuidSchema } from "./common.js";
import { getPublicEventRequest } from "./public-event.js";

/** The named colours a ticket may take; the booking site paints each from its own palette. */
export const TICKET_DESIGN_COLORS = ["pink", "wine", "purple", "green", "amber", "red", "orange", "blue", "teal", "black"] as const;
/** The pictures a design may carry. */
export const TICKET_IMAGE_SLOTS = ["logo", "picture", "artwork"] as const;
export type TicketImageSlot = (typeof TICKET_IMAGE_SLOTS)[number];

const eventParamsSchema = organizationIdParamsSchema.extend({ eventId: uuidSchema });
const imageParamsSchema = eventParamsSchema.extend({ slot: z.enum(TICKET_IMAGE_SLOTS) });

const fraction = z.number().min(0).max(1);
const qrSizeSchema = z.enum(["s", "m", "l"] as const satisfies readonly TicketQrSize[]);

/** PUT replaces the settings: anything left out goes back to its default. Pictures have their own endpoints. */
export const ticketDesignSaveSchema = z.strictObject({
  /** The booking site owns the list of layouts; "custom" is the organizer's own artwork. */
  design: z.string().regex(/^[a-z][a-z-]{0,29}$/, "Design is a lowercase name such as poster or custom"),
  /** A named colour or #rrggbb; null or left out keeps the design's own colours. */
  color: z
    .union([z.enum(TICKET_DESIGN_COLORS), z.string().regex(/^#[0-9a-f]{6}$/, "A colour of your own is #rrggbb in lowercase")])
    .nullable()
    .default(null),
  note: nullableText(60),
  show_price: z.boolean().default(true),
  show_venue: z.boolean().default(true),
  show_guest: z.boolean().default(true),
  qr: z.strictObject({ x: fraction, y: fraction, size: qrSizeSchema }).default({ x: 0.5, y: 1, size: "m" }),
});

export type TicketDesignSaveInput = z.output<typeof ticketDesignSaveSchema>;

// One contract per endpoint (see middleware/validate.ts).
export const getTicketDesignRequest = { params: eventParamsSchema } satisfies RequestContract;

export const saveTicketDesignRequest = { params: eventParamsSchema, body: ticketDesignSaveSchema } satisfies RequestContract;

export const removeTicketDesignRequest = { params: eventParamsSchema } satisfies RequestContract;

/** The image itself arrives as multipart/form-data (field "file"), parsed by middleware/upload.ts after authorization. */
export const setTicketImageRequest = { params: imageParamsSchema } satisfies RequestContract;

export const removeTicketImageRequest = { params: imageParamsSchema } satisfies RequestContract;

export const getPublicTicketDesignRequest = { params: getPublicEventRequest.params } satisfies RequestContract;
