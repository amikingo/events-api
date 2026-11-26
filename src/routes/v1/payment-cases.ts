import { Router } from "express";
import { paymentCaseController } from "../../controllers/payment-case.controller.js";
import { requireStaffAuthentication } from "../../middleware/authentication.js";
import { organizationScopeFromParams, requirePermission } from "../../middleware/permission.js";
import { validate } from "../../middleware/validate.js";
import { MODULE_CODES } from "../../utils/module-codes.js";
import { getPaymentCaseRequest, listPaymentCasesRequest, resolvePaymentCaseRequest } from "../../validators/payment-case.js";

/**
 * Mounted at /v1/organizations/:organizationId/payment-cases (Phase 8 step 3): refunds due, double charges and
 * mismatched amounts. The Payments module (view to read, update to resolve), in the path's organization: separate
 * from Guests, so door staff can't record refunds.
 */
export const paymentCasesRouter = Router({ mergeParams: true });

// Every route reads top to bottom: authenticate -> validate -> authorize -> controller.
paymentCasesRouter.get(
  "/",
  requireStaffAuthentication,
  validate(listPaymentCasesRequest),
  requirePermission({ moduleCode: MODULE_CODES.PAYMENTS, action: "view", scope: organizationScopeFromParams }),
  paymentCaseController.list,
);

paymentCasesRouter.get(
  "/:caseId",
  requireStaffAuthentication,
  validate(getPaymentCaseRequest),
  requirePermission({ moduleCode: MODULE_CODES.PAYMENTS, action: "view", scope: organizationScopeFromParams }),
  paymentCaseController.get,
);

paymentCasesRouter.post(
  "/:caseId/resolve",
  requireStaffAuthentication,
  validate(resolvePaymentCaseRequest),
  requirePermission({ moduleCode: MODULE_CODES.PAYMENTS, action: "update", scope: organizationScopeFromParams }),
  paymentCaseController.resolve,
);
