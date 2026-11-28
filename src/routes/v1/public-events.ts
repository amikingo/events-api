import { Router } from "express";
import { orderController } from "../../controllers/order.controller.js";
import { publicEventController } from "../../controllers/public-event.controller.js";
import { publicRegistrationController } from "../../controllers/public-registration.controller.js";
import { ticketDesignController } from "../../controllers/ticket-design.controller.js";
import { venueLocationController } from "../../controllers/venue-location.controller.js";
import { optionalCustomerAuthentication } from "../../middleware/authentication.js";
import { publicReadLimiter, publicRegistrationLimiter } from "../../middleware/rate-limit.js";
import { validate } from "../../middleware/validate.js";
import { getPublicEventRequest, listPublicEventsRequest } from "../../validators/public-event.js";
import { createPublicOrderRequest } from "../../validators/order.js";
import { checkPublicPaymentRequest, getPublicOrderRequest, startPublicPaymentRequest } from "../../validators/payment.js";
import { createPublicRegistrationRequest } from "../../validators/public-registration.js";
import { getPublicTicketDesignRequest } from "../../validators/ticket-design.js";
import { getPublicVenueLocationRequest } from "../../validators/venue-location.js";

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

// How the event's tickets look, for the buyer's order page and tickets; null when the standard designs apply.
publicEventsRouter.get(
  "/organizations/:organizationSlug/events/:eventSlug/ticket-design",
  publicReadLimiter,
  validate(getPublicTicketDesignRequest),
  ticketDesignController.getPublicTicketDesign,
);

// Where the event's venue is on the map; null when it has no pin.
publicEventsRouter.get(
  "/organizations/:organizationSlug/events/:eventSlug/venue-location",
  publicReadLimiter,
  validate(getPublicVenueLocationRequest),
  venueLocationController.getPublicVenueLocation,
);

// Phase 4b: register for an event by link, without an account. Idempotency-Key is required (see the validator).
// Phase 6: a guest signed in with a Cheche account sends its access token, and registers through its linked profile.
publicEventsRouter.post(
  "/organizations/:organizationSlug/events/:eventSlug/registrations",
  publicRegistrationLimiter,
  optionalCustomerAuthentication,
  validate(createPublicRegistrationRequest),
  publicRegistrationController.registerForEvent,
);

// Phase 7: checkout, several tickets in one order (Idempotency-Key required). Shares the registration form's limit.
publicEventsRouter.post(
  "/organizations/:organizationSlug/events/:eventSlug/orders",
  publicRegistrationLimiter,
  optionalCustomerAuthentication,
  validate(createPublicOrderRequest),
  orderController.createPublicOrder,
);

// Phase 7 step 3: the buyer's order page, with the order token from checkout in the X-Order-Token header.
publicEventsRouter.get("/orders/:reference", publicReadLimiter, validate(getPublicOrderRequest), orderController.getPublicOrder);
publicEventsRouter.post("/orders/:reference/payment", publicRegistrationLimiter, validate(startPublicPaymentRequest), orderController.startPublicPayment);
// Phase 7 step 3b: back from Cheche Pay, the order page asks the server to verify the payment now.
publicEventsRouter.post("/orders/:reference/check", publicRegistrationLimiter, validate(checkPublicPaymentRequest), orderController.checkPublicPayment);
