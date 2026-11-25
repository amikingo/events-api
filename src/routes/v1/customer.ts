import { Router } from "express";
import { customerController } from "../../controllers/customer.controller.js";
import { requireCustomerAuthentication } from "../../middleware/authentication.js";
import { noStore } from "../../middleware/auth-refresh-security.js";
import { validate } from "../../middleware/validate.js";
import { listMyTicketsRequest } from "../../validators/customer.js";

/**
 * Mounted at /v1/customer (Phase 6). A guest signed in with a Cheche account sees their own data only; the identity
 * comes from the access token, never from the path, query or body. Staff tokens are refused here.
 */
export const customerRouter = Router();

customerRouter.get("/registrations", requireCustomerAuthentication, noStore, validate(listMyTicketsRequest), customerController.listMyTickets);
