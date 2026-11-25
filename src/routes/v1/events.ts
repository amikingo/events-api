import { Router } from "express";
import { eventController } from "../../controllers/event.controller.js";
import { requireStaffAuthentication } from "../../middleware/authentication.js";
import { organizationScopeFromParams, requirePermission } from "../../middleware/permission.js";
import { coverImageUpload } from "../../middleware/upload.js";
import { validate } from "../../middleware/validate.js";
import { MODULE_CODES } from "../../utils/module-codes.js";
import {
  changeEventStatusRequest,
  createEventRequest,
  getEventRequest,
  listEventsRequest,
  removeEventCoverRequest,
  setEventCoverRequest,
  updateEventRequest,
} from "../../validators/event.js";

/**
 * Mounted at /v1/organizations/:organizationId/events (mergeParams exposes :organizationId). Organization-level
 * back office: branch-limited staff get 403 during the organization-first pilot.
 */
export const eventsRouter = Router({ mergeParams: true });

// Every route reads top to bottom: authenticate -> validate -> authorize -> controller.
eventsRouter.post(
  "/",
  requireStaffAuthentication,
  validate(createEventRequest),
  requirePermission({ moduleCode: MODULE_CODES.EVENTS, action: "create", scope: organizationScopeFromParams }),
  eventController.createEvent,
);

eventsRouter.get(
  "/",
  requireStaffAuthentication,
  validate(listEventsRequest),
  requirePermission({ moduleCode: MODULE_CODES.EVENTS, action: "view", scope: organizationScopeFromParams }),
  eventController.listEvents,
);

eventsRouter.get(
  "/:eventId",
  requireStaffAuthentication,
  validate(getEventRequest),
  requirePermission({ moduleCode: MODULE_CODES.EVENTS, action: "view", scope: organizationScopeFromParams }),
  eventController.getEvent,
);

eventsRouter.patch(
  "/:eventId",
  requireStaffAuthentication,
  validate(updateEventRequest),
  requirePermission({ moduleCode: MODULE_CODES.EVENTS, action: "update", scope: organizationScopeFromParams }),
  eventController.updateEvent,
);

// Publish, close or cancel.
eventsRouter.patch(
  "/:eventId/status",
  requireStaffAuthentication,
  validate(changeEventStatusRequest),
  requirePermission({ moduleCode: MODULE_CODES.EVENTS, action: "update", scope: organizationScopeFromParams }),
  eventController.changeEventStatus,
);

// Cover upload: the multipart body is parsed only after authentication and authorization.
eventsRouter.put(
  "/:eventId/cover",
  requireStaffAuthentication,
  validate(setEventCoverRequest),
  requirePermission({ moduleCode: MODULE_CODES.EVENTS, action: "update", scope: organizationScopeFromParams }),
  coverImageUpload,
  eventController.setEventCover,
);

eventsRouter.delete(
  "/:eventId/cover",
  requireStaffAuthentication,
  validate(removeEventCoverRequest),
  requirePermission({ moduleCode: MODULE_CODES.EVENTS, action: "update", scope: organizationScopeFromParams }),
  eventController.removeEventCover,
);
