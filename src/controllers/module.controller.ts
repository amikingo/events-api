import type { Request, Response } from "express";
import { getValidated } from "../middleware/validate.js";
import { moduleService } from "../services/module.service.js";
import { sendSuccess } from "../utils/http.js";
import { changeModuleStatusRequest, createModuleRequest, updateModuleRequest } from "../validators/module.js";
import { getActorId } from "./helpers.js";

/** Modules (Phase 2d, extended in Phase 2e): the Super Admin's menu and permission list. */
async function listModules(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, 200, await moduleService.listModuleTree(), "Modules retrieved");
}

async function createModule(req: Request, res: Response): Promise<void> {
  const { body } = getValidated(req, createModuleRequest);
  sendSuccess(res, 201, await moduleService.createModule(body, getActorId(req)), "Module created");
}

async function updateModule(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, updateModuleRequest);
  sendSuccess(res, 200, await moduleService.updateModule(params.moduleId, body, getActorId(req)), "Module updated");
}

async function changeModuleStatus(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, changeModuleStatusRequest);
  const module = await moduleService.changeModuleStatus(params.moduleId, body.is_active, getActorId(req));
  const message = module.is_active ? "Module switched on" : "Module switched off: nobody can use it, the Super Admin included, and it has left every menu";
  sendSuccess(res, 200, module, message);
}

export const moduleController = { listModules, createModule, updateModule, changeModuleStatus };
