import { Router } from "express";
import { publicEventController } from "../../controllers/public-event.controller.js";
import { publicRegistrationController } from "../../controllers/public-registration.controller.js";
import { publicReadLimiter, publicRegistrationLimiter } from "../../middleware/rate-limit.js";
import { validate } from "../../middleware/validate.js";
import { getPublicEventRequest, listPublicEventsRequest } from "../../validators/public-event.js";
import { createPublicRegistrationRequest } from "../../validators/public-registration.js";

/**
 * Mounted at /v1/public. No login: visitors browse the catalog and open events by link. Only visitor fields are
 * returned (see mappers/event.mapper.ts); every request is rate limited per IP.
 */
export const publicEventsRouter = Router();

publicEventsRouter.get("/events", publicReadLimiter, validate(listPublicEventsRequest), publicEventController.listCatalog);

publicEventsRouter.get(
  "/organizations/:organizationSlug/events/:eventSlug",
  publicReadLimiter,
  validate(getPublicEventRequest),
  publicEventController.getPublicEvent,
);

// Phase 4b: register for an event by link, without an account. Idempotency-Key is required (see the validator).
publicEventsRouter.post(
  "/organizations/:organizationSlug/events/:eventSlug/registrations",
  publicRegistrationLimiter,
  validate(createPublicRegistrationRequest),
  publicRegistrationController.registerForEvent,
);
