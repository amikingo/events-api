import type { Request, Response } from "express";
import { getValidated } from "../middleware/validate.js";
import { chechePayCredentialService } from "../services/cheche-pay-credential.service.js";
import { sendSuccess } from "../utils/http.js";
import {
  checkChechePayCredentialRequest,
  deleteChechePayCredentialRequest,
  getChechePayCredentialRequest,
  saveChechePayCredentialRequest,
} from "../validators/cheche-pay-credential.js";
import { getActorId } from "./helpers.js";

/** An organizer's Cheche Pay v2 keys (Phase 7 step 3b), Super Admin only. Replies never contain a secret. */
async function get(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, getChechePayCredentialRequest);
  sendSuccess(res, 200, await chechePayCredentialService.get(params.organizationId), "Cheche Pay keys retrieved");
}

async function save(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, saveChechePayCredentialRequest);
  sendSuccess(res, 200, await chechePayCredentialService.save(params.organizationId, body, getActorId(req)), "Cheche Pay keys saved");
}

async function remove(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, deleteChechePayCredentialRequest);
  sendSuccess(res, 200, await chechePayCredentialService.remove(params.organizationId), "Cheche Pay keys removed");
}

async function check(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, checkChechePayCredentialRequest);
  const result = await chechePayCredentialService.check(params.organizationId);
  sendSuccess(res, 200, result, result.ok ? "Cheche Pay accepted the key" : "Cheche Pay didn't accept the key");
}

export const chechePayCredentialController = { get, save, remove, check };
