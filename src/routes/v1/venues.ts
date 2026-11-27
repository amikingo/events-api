import { Router } from "express";
import { venueLocationController } from "../../controllers/venue-location.controller.js";
import { venueController } from "../../controllers/venue.controller.js";
import { requireStaffAuthentication } from "../../middleware/authentication.js";
import { organizationScopeFromParams, requirePermission } from "../../middleware/permission.js";
import { validate } from "../../middleware/validate.js";
import { MODULE_CODES } from "../../utils/module-codes.js";
import {
  changeVenueStatusRequest,
  createVenueRequest,
  getVenueRequest,
  listVenuesRequest,
  updateVenueRequest,
} from "../../validators/venue.js";
import { getVenueLocationRequest, removeVenueLocationRequest, saveVenueLocationRequest } from "../../validators/venue-location.js";

/**
 * Mounted at /v1/organizations/:organizationId/venues (mergeParams exposes :organizationId).
 * Venues belong to event planning, so they use the EVENTS permission module.
 */
export const venuesRouter = Router({ mergeParams: true });

// Every route reads top to bottom: authenticate -> validate -> authorize -> controller.
venuesRouter.post(
  "/",
  requireStaffAuthentication,
  validate(createVenueRequest),
  requirePermission({ moduleCode: MODULE_CODES.EVENTS, action: "create", scope: organizationScopeFromParams }),
  venueController.createVenue,
);

venuesRouter.get(
  "/",
  requireStaffAuthentication,
  validate(listVenuesRequest),
  requirePermission({ moduleCode: MODULE_CODES.EVENTS, action: "view", scope: organizationScopeFromParams }),
  venueController.listVenues,
);

venuesRouter.get(
  "/:venueId",
  requireStaffAuthentication,
  validate(getVenueRequest),
  requirePermission({ moduleCode: MODULE_CODES.EVENTS, action: "view", scope: organizationScopeFromParams }),
  venueController.getVenue,
);

venuesRouter.patch(
  "/:venueId",
  requireStaffAuthentication,
  validate(updateVenueRequest),
  requirePermission({ moduleCode: MODULE_CODES.EVENTS, action: "update", scope: organizationScopeFromParams }),
  venueController.updateVenue,
);

venuesRouter.patch(
  "/:venueId/status",
  requireStaffAuthentication,
  validate(changeVenueStatusRequest),
  requirePermission({ moduleCode: MODULE_CODES.EVENTS, action: "update", scope: organizationScopeFromParams }),
  venueController.changeVenueStatus,
);

// The venue's pin on the map (its own resource, so venue reads don't depend on its table).
venuesRouter.get(
  "/:venueId/location",
  requireStaffAuthentication,
  validate(getVenueLocationRequest),
  requirePermission({ moduleCode: MODULE_CODES.EVENTS, action: "view", scope: organizationScopeFromParams }),
  venueLocationController.getVenueLocation,
);

venuesRouter.put(
  "/:venueId/location",
  requireStaffAuthentication,
  validate(saveVenueLocationRequest),
  requirePermission({ moduleCode: MODULE_CODES.EVENTS, action: "update", scope: organizationScopeFromParams }),
  venueLocationController.saveVenueLocation,
);

venuesRouter.delete(
  "/:venueId/location",
  requireStaffAuthentication,
  validate(removeVenueLocationRequest),
  requirePermission({ moduleCode: MODULE_CODES.EVENTS, action: "update", scope: organizationScopeFromParams }),
  venueLocationController.removeVenueLocation,
);
