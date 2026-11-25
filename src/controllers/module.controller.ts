import type { Request, Response } from "express";
import { getValidated } from "../middleware/validate.js";
import { moduleService } from "../services/module.service.js";
import { sendSuccess } from "../utils/http.js";
import { updateModuleRequest } from "../validators/module.js";
import { getActorId } from "./helpers.js";

/** Modules (Phase 2d): the Super Admin's menu and permission list. */
async function listModules(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, 200, await moduleService.listModuleTree(), "Modules retrieved");
}

async function updateModule(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, updateModuleRequest);
  sendSuccess(res, 200, await moduleService.updateModule(params.moduleId, body, getActorId(req)), "Module updated");
}

export const moduleController = { listModules, updateModule };
