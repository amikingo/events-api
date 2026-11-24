import { Router } from "express";
import { customerAccountController } from "../../controllers/customer-account.controller.js";
import { requireStaffAuthentication } from "../../middleware/authentication.js";
import { organizationScopeFromParams, requirePermission } from "../../middleware/permission.js";
import { validate } from "../../middleware/validate.js";
import { MODULE_CODES } from "../../utils/module-codes.js";
import {
  changeCustomerAccountStatusRequest,
  createCustomerAccountRequest,
  getCustomerAccountRequest,
  listCustomerAccountsRequest,
  updateCustomerAccountRequest,
} from "../../validators/customer-account.js";

/** Mounted at /v1/organizations/:organizationId/customer-accounts (mergeParams exposes :organizationId). */
export const customerAccountsRouter = Router({ mergeParams: true });

// Every route reads top to bottom: authenticate -> validate -> authorize -> controller.
customerAccountsRouter.post(
  "/",
  requireStaffAuthentication,
  validate(createCustomerAccountRequest),
  requirePermission({ moduleCode: MODULE_CODES.CUSTOMERS, action: "create", scope: organizationScopeFromParams }),
  customerAccountController.createCustomerAccount,
);

customerAccountsRouter.get(
  "/",
  requireStaffAuthentication,
  validate(listCustomerAccountsRequest),
  requirePermission({ moduleCode: MODULE_CODES.CUSTOMERS, action: "view", scope: organizationScopeFromParams }),
  customerAccountController.listCustomerAccounts,
);

customerAccountsRouter.get(
  "/:customerAccountId",
  requireStaffAuthentication,
  validate(getCustomerAccountRequest),
  requirePermission({ moduleCode: MODULE_CODES.CUSTOMERS, action: "view", scope: organizationScopeFromParams }),
  customerAccountController.getCustomerAccount,
);

customerAccountsRouter.patch(
  "/:customerAccountId",
  requireStaffAuthentication,
  validate(updateCustomerAccountRequest),
  requirePermission({ moduleCode: MODULE_CODES.CUSTOMERS, action: "update", scope: organizationScopeFromParams }),
  customerAccountController.updateCustomerAccount,
);

customerAccountsRouter.patch(
  "/:customerAccountId/status",
  requireStaffAuthentication,
  validate(changeCustomerAccountStatusRequest),
  requirePermission({ moduleCode: MODULE_CODES.CUSTOMERS, action: "update", scope: organizationScopeFromParams }),
  customerAccountController.changeCustomerAccountStatus,
);
