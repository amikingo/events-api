import { Router } from "express";
import { ticketDesignController } from "../../controllers/ticket-design.controller.js";
import { requireStaffAuthentication } from "../../middleware/authentication.js";
import { organizationScopeFromParams, requirePermission } from "../../middleware/permission.js";
import { singleImageUpload } from "../../middleware/upload.js";
import { validate } from "../../middleware/validate.js";
import { MODULE_CODES } from "../../utils/module-codes.js";
import {
  getTicketDesignRequest,
  removeTicketDesignRequest,
  removeTicketImageRequest,
  saveTicketDesignRequest,
  setTicketImageRequest,
} from "../../validators/ticket-design.js";

/**
 * Mounted at /v1/organizations/:organizationId/events/:eventId/ticket-design (mergeParams exposes both ids). Part of
 * an event, so it uses the Events permission.
 */
export const ticketDesignRouter = Router({ mergeParams: true });

ticketDesignRouter.get(
  "/",
  requireStaffAuthentication,
  validate(getTicketDesignRequest),
  requirePermission({ moduleCode: MODULE_CODES.EVENTS, action: "view", scope: organizationScopeFromParams }),
  ticketDesignController.getTicketDesign,
);

ticketDesignRouter.put(
  "/",
  requireStaffAuthentication,
  validate(saveTicketDesignRequest),
  requirePermission({ moduleCode: MODULE_CODES.EVENTS, action: "update", scope: organizationScopeFromParams }),
  ticketDesignController.saveTicketDesign,
);

ticketDesignRouter.delete(
  "/",
  requireStaffAuthentication,
  validate(removeTicketDesignRequest),
  requirePermission({ moduleCode: MODULE_CODES.EVENTS, action: "update", scope: organizationScopeFromParams }),
  ticketDesignController.removeTicketDesign,
);

// Image upload: the multipart body is parsed only after authentication and authorization.
ticketDesignRouter.put(
  "/images/:slot",
  requireStaffAuthentication,
  validate(setTicketImageRequest),
  requirePermission({ moduleCode: MODULE_CODES.EVENTS, action: "update", scope: organizationScopeFromParams }),
  singleImageUpload,
  ticketDesignController.setTicketImage,
);

ticketDesignRouter.delete(
  "/images/:slot",
  requireStaffAuthentication,
  validate(removeTicketImageRequest),
  requirePermission({ moduleCode: MODULE_CODES.EVENTS, action: "update", scope: organizationScopeFromParams }),
  ticketDesignController.removeTicketImage,
);
