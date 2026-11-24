import type { Request, Response } from "express";
import { getValidated } from "../middleware/validate.js";
import { customerAccountService } from "../services/customer-account.service.js";
import { sendList, sendSuccess } from "../utils/http.js";
import {
  changeCustomerAccountStatusRequest,
  createCustomerAccountRequest,
  getCustomerAccountRequest,
  listCustomerAccountsRequest,
  updateCustomerAccountRequest,
} from "../validators/customer-account.js";
import { getActorId } from "./helpers.js";

async function createCustomerAccount(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, createCustomerAccountRequest);
  const client = await customerAccountService.createCustomerAccount(params.organizationId, body, getActorId(req));
  sendSuccess(res, 201, client, "Client created");
}

async function listCustomerAccounts(req: Request, res: Response): Promise<void> {
  const { params, query } = getValidated(req, listCustomerAccountsRequest);
  const { rows, count } = await customerAccountService.listCustomerAccounts(params.organizationId, query);
  sendList(res, 200, rows, { count, page: query.page, pageSize: query.pageSize }, "Clients retrieved");
}

async function getCustomerAccount(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, getCustomerAccountRequest);
  const client = await customerAccountService.getCustomerAccount(params.organizationId, params.customerAccountId);
  sendSuccess(res, 200, client, "Client retrieved");
}

async function updateCustomerAccount(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, updateCustomerAccountRequest);
  const client = await customerAccountService.updateCustomerAccount(params.organizationId, params.customerAccountId, body, getActorId(req));
  sendSuccess(res, 200, client, "Client updated");
}

async function changeCustomerAccountStatus(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, changeCustomerAccountStatusRequest);
  const client = await customerAccountService.changeCustomerAccountStatus(
    params.organizationId,
    params.customerAccountId,
    body.is_active,
    getActorId(req),
  );
  sendSuccess(res, 200, client, "Client status updated");
}

export const customerAccountController = {
  createCustomerAccount,
  listCustomerAccounts,
  getCustomerAccount,
  updateCustomerAccount,
  changeCustomerAccountStatus,
};
