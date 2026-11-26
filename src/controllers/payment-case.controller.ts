import type { Request, Response } from "express";
import { getValidated } from "../middleware/validate.js";
import { paymentCaseService } from "../services/payment-case.service.js";
import { sendList, sendSuccess } from "../utils/http.js";
import { getPaymentCaseRequest, listPaymentCasesRequest, resolvePaymentCaseRequest } from "../validators/payment-case.js";
import { getActorId } from "./helpers.js";

/** Payment cases (Phase 8 step 3), the Payments module. */
async function list(req: Request, res: Response): Promise<void> {
  const { params, query } = getValidated(req, listPaymentCasesRequest);
  const { rows, count } = await paymentCaseService.list(params.organizationId, query);
  sendList(res, 200, rows, { count, page: query.page, pageSize: query.pageSize }, "Payment cases retrieved");
}

async function get(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, getPaymentCaseRequest);
  sendSuccess(res, 200, await paymentCaseService.get(params.organizationId, params.caseId), "Payment case retrieved");
}

async function resolve(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, resolvePaymentCaseRequest);
  sendSuccess(res, 200, await paymentCaseService.resolve(params.organizationId, params.caseId, body, getActorId(req) as string), "Payment case resolved");
}

export const paymentCaseController = { list, get, resolve };
