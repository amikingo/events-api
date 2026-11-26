import type { Request, Response } from "express";
import { getValidated } from "../middleware/validate.js";
import { checkoutService } from "../services/checkout.service.js";
import { publicCheckoutService } from "../services/public-checkout.service.js";
import { sendList, sendSuccess } from "../utils/http.js";
import { createPublicOrderRequest, createStaffOrderRequest, getOrderRequest, listOrdersRequest } from "../validators/order.js";
import { getPublicOrderRequest, listPublicPaymentOptionsRequest, startPublicPaymentRequest } from "../validators/payment.js";
import { getActorId, getOptionalCustomerAuth } from "./helpers.js";

/** Checkout (Phase 7): 201 for a new order; 200 with the same order when the same request (Idempotency-Key) is sent again. */
async function createStaffOrder(req: Request, res: Response): Promise<void> {
  const { params, headers, body } = getValidated(req, createStaffOrderRequest);
  const { order, outcome } = await checkoutService.createStaffOrder(params.organizationId, params.eventId, body, getActorId(req), headers["idempotency-key"]);
  if (outcome === "REPLAYED") {
    sendSuccess(res, 200, order, "Same request already processed");
    return;
  }
  if (order.status === "PENDING_PAYMENT") {
    sendSuccess(res, 201, order, "Order created: waiting for the buyer's payment");
    return;
  }
  sendSuccess(res, 201, order, order.ticket_count === 1 ? "Ticket issued" : `${order.ticket_count} tickets issued`);
}

async function listOrders(req: Request, res: Response): Promise<void> {
  const { params, query } = getValidated(req, listOrdersRequest);
  const { rows, count } = await checkoutService.listOrders(params.organizationId, params.eventId, query);
  sendList(res, 200, rows, { count, page: query.page, pageSize: query.pageSize }, "Orders retrieved");
}

async function getOrder(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, getOrderRequest);
  sendSuccess(res, 200, await checkoutService.getOrder(params.organizationId, params.eventId, params.orderId), "Order retrieved");
}

async function createPublicOrder(req: Request, res: Response): Promise<void> {
  const { params, headers, body } = getValidated(req, createPublicOrderRequest);
  const { order, outcome } = await publicCheckoutService.checkoutFromPublicForm(
    params.organizationSlug,
    params.eventSlug,
    headers["idempotency-key"],
    body,
    getOptionalCustomerAuth(req),
  );
  if (outcome === "REPLAYED") {
    sendSuccess(res, 200, order, "Already ordered with this request");
    return;
  }
  if (order.status === "PENDING_PAYMENT") {
    sendSuccess(res, 201, order, "Order created: pay to get your tickets");
    return;
  }
  sendSuccess(res, 201, order, order.tickets.length === 1 ? "Your ticket is ready" : "Your tickets are ready");
}

/** Phase 7 step 3: the buyer's order page (the order token in X-Order-Token; a wrong token is 404). */
async function getPublicOrder(req: Request, res: Response): Promise<void> {
  const { params, headers } = getValidated(req, getPublicOrderRequest);
  sendSuccess(res, 200, await publicCheckoutService.getOrder(params.reference, headers["x-order-token"]), "Order retrieved");
}

async function startPublicPayment(req: Request, res: Response): Promise<void> {
  const { params, headers } = getValidated(req, startPublicPaymentRequest);
  sendSuccess(res, 200, await publicCheckoutService.startPayment(params.reference, headers["x-order-token"]), "Payment ready");
}

async function listPublicPaymentOptions(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, listPublicPaymentOptionsRequest);
  sendSuccess(res, 200, await publicCheckoutService.listPaymentOptions(params.organizationSlug, params.eventSlug), "Payment options retrieved");
}

export const orderController = { createStaffOrder, listOrders, getOrder, createPublicOrder, getPublicOrder, startPublicPayment, listPublicPaymentOptions };
