import { z } from "zod";
import type { RequestContract } from "../middleware/validate.js";
import { getPublicEventRequest } from "./public-event.js";
import { venueParamsSchema } from "./venue.js";

export const venueLocationSaveSchema = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

export type VenueLocationSaveInput = z.output<typeof venueLocationSaveSchema>;

// One contract per endpoint (see middleware/validate.ts).
export const getVenueLocationRequest = { params: venueParamsSchema } satisfies RequestContract;

export const saveVenueLocationRequest = { params: venueParamsSchema, body: venueLocationSaveSchema } satisfies RequestContract;

export const removeVenueLocationRequest = { params: venueParamsSchema } satisfies RequestContract;

export const getPublicVenueLocationRequest = { params: getPublicEventRequest.params } satisfies RequestContract;
