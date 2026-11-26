import { Router } from "express";
import { orderController } from "../../controllers/order.controller.js";
import { requireStaffAuthentication } from "../../middleware/authentication.js";
import { organizationScopeFromParams, requirePermission } from "../../middleware/permission.js";
import { validate } from "../../middleware/validate.js";
import { MODULE_CODES } from "../../utils/module-codes.js";
import { createStaffOrderRequest, getOrderRequest, listOrdersRequest } from "../../validators/order.js";

/**
 * Mounted at /v1/organizations/:organizationId/events/:eventId/orders (mergeParams exposes both ids). Phase 7
 * checkout for staff: orders are part of the guest list, so they use the Guests module (REGISTRATIONS).
 */
export const ordersRouter = Router({ mergeParams: true });

// Every route reads top to bottom: authenticate -> validate -> authorize -> controller.
ordersRouter.post(
  "/",
  requireStaffAuthentication,
  validate(createStaffOrderRequest),
  requirePermission({ moduleCode: MODULE_CODES.REGISTRATIONS, action: "create", scope: organizationScopeFromParams }),
  orderController.createStaffOrder,
);

ordersRouter.get(
  "/",
  requireStaffAuthentication,
  validate(listOrdersRequest),
  requirePermission({ moduleCode: MODULE_CODES.REGISTRATIONS, action: "view", scope: organizationScopeFromParams }),
  orderController.listOrders,
);

ordersRouter.get(
  "/:orderId",
  requireStaffAuthentication,
  validate(getOrderRequest),
  requirePermission({ moduleCode: MODULE_CODES.REGISTRATIONS, action: "view", scope: organizationScopeFromParams }),
  orderController.getOrder,
);
