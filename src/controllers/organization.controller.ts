import type { Request, Response } from "express";
import { organizationService } from "../services/organization.service.js";
import { sendList, sendSuccess } from "../utils/http.js";
import {
  changeOrganizationStatusRequest,
  createOrganizationRequest,
  getOrganizationRequest,
  listOrganizationsRequest,
  updateOrganizationSettingsRequest,
} from "../validators/organization.js";
import { getValidated } from "../middleware/validate.js";
import { getActorId } from "./helpers.js";

async function createOrganization(req: Request, res: Response): Promise<void> {
  const { body } = getValidated(req, createOrganizationRequest);
  const result = await organizationService.createOrganization(body, getActorId(req));
  sendSuccess(res, 201, result, "Organization created");
}

async function listOrganizations(req: Request, res: Response): Promise<void> {
  const { query } = getValidated(req, listOrganizationsRequest);
  const { rows, count } = await organizationService.listOrganizations(query);
  sendList(res, 200, rows, { count, page: query.page, pageSize: query.pageSize }, "Organizations retrieved");
}

async function getOrganization(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, getOrganizationRequest);
  const organization = await organizationService.getOrganization(params.organizationId);
  sendSuccess(res, 200, organization, "Organization retrieved");
}

async function updateOrganizationSettings(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, updateOrganizationSettingsRequest);
  const organization = await organizationService.updateOrganizationSettings(params.organizationId, body, getActorId(req));
  sendSuccess(res, 200, organization, "Organization settings updated");
}

async function changeOrganizationStatus(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, changeOrganizationStatusRequest);
  const organization = await organizationService.changeOrganizationStatus(params.organizationId, body.is_active, getActorId(req));
  sendSuccess(res, 200, organization, body.is_active ? "Organization switched on" : "Organization switched off");
}

export const organizationController = { createOrganization, listOrganizations, getOrganization, updateOrganizationSettings, changeOrganizationStatus };
