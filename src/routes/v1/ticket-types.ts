import { Router } from "express";
import { ticketTypeController } from "../../controllers/ticket-type.controller.js";
import { requireStaffAuthentication } from "../../middleware/authentication.js";
import { organizationScopeFromParams, requirePermission } from "../../middleware/permission.js";
import { validate } from "../../middleware/validate.js";
import { MODULE_CODES } from "../../utils/module-codes.js";
import {
  changeTicketTypeStatusRequest,
  createTicketTypeRequest,
  listTicketTypesRequest,
  updateTicketTypeRequest,
} from "../../validators/ticket-type.js";

/**
 * Mounted at /v1/organizations/:organizationId/events/:eventId/ticket-types (mergeParams exposes both ids).
 * Ticket types are part of an event's set-up, so changing them needs EVENTS update.
 */
export const ticketTypesRouter = Router({ mergeParams: true });

// Every route reads top to bottom: authenticate -> validate -> authorize -> controller.
ticketTypesRouter.post(
  "/",
  requireStaffAuthentication,
  validate(createTicketTypeRequest),
  requirePermission({ moduleCode: MODULE_CODES.EVENTS, action: "update", scope: organizationScopeFromParams }),
  ticketTypeController.createTicketType,
);

ticketTypesRouter.get(
  "/",
  requireStaffAuthentication,
  validate(listTicketTypesRequest),
  requirePermission({ moduleCode: MODULE_CODES.EVENTS, action: "view", scope: organizationScopeFromParams }),
  ticketTypeController.listTicketTypes,
);

ticketTypesRouter.patch(
  "/:ticketTypeId",
  requireStaffAuthentication,
  validate(updateTicketTypeRequest),
  requirePermission({ moduleCode: MODULE_CODES.EVENTS, action: "update", scope: organizationScopeFromParams }),
  ticketTypeController.updateTicketType,
);

ticketTypesRouter.patch(
  "/:ticketTypeId/status",
  requireStaffAuthentication,
  validate(changeTicketTypeStatusRequest),
  requirePermission({ moduleCode: MODULE_CODES.EVENTS, action: "update", scope: organizationScopeFromParams }),
  ticketTypeController.changeTicketTypeStatus,
);
