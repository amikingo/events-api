import { Router } from "express";
import { publicEventController } from "../../controllers/public-event.controller.js";
import { publicReadLimiter } from "../../middleware/rate-limit.js";
import { validate } from "../../middleware/validate.js";
import { getPublicEventRequest, listPublicEventsRequest } from "../../validators/public-event.js";

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
