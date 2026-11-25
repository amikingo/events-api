import type { Request, Response } from "express";
import { getValidated } from "../middleware/validate.js";
import { registrationService } from "../services/registration.service.js";
import { sendList, sendSuccess } from "../utils/http.js";
import {
  changeRegistrationStatusRequest,
  createRegistrationRequest,
  getRegistrationRequest,
  getRegistrationSummaryRequest,
  listRegistrationsRequest,
} from "../validators/registration.js";
import { getActorId } from "./helpers.js";

/** 201 when a place was taken (new or reactivated); 200 when the same confirmed registration already existed. */
async function registerGuest(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, createRegistrationRequest);
  const { registration, outcome } = await registrationService.registerGuest(params.organizationId, params.eventId, body, getActorId(req));
  if (outcome === "UNCHANGED") {
    sendSuccess(res, 200, registration, "Guest is already registered");
    return;
  }
  sendSuccess(res, 201, registration, outcome === "REACTIVATED" ? "Registration reactivated" : "Guest registered");
}

async function listRegistrations(req: Request, res: Response): Promise<void> {
  const { params, query } = getValidated(req, listRegistrationsRequest);
  const { rows, count } = await registrationService.listRegistrations(params.organizationId, params.eventId, query);
  sendList(res, 200, rows, { count, page: query.page, pageSize: query.pageSize }, "Registrations retrieved");
}

async function getRegistrationSummary(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, getRegistrationSummaryRequest);
  const summary = await registrationService.getRegistrationSummary(params.organizationId, params.eventId);
  sendSuccess(res, 200, summary, "Registration summary retrieved");
}

async function getRegistration(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, getRegistrationRequest);
  const registration = await registrationService.getRegistration(params.organizationId, params.eventId, params.registrationId);
  sendSuccess(res, 200, registration, "Registration retrieved");
}

async function changeRegistrationStatus(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, changeRegistrationStatusRequest);
  const registration = await registrationService.changeRegistrationStatus(
    params.organizationId,
    params.eventId,
    params.registrationId,
    body.status,
    getActorId(req),
  );
  sendSuccess(res, 200, registration, "Registration status updated");
}

export const registrationController = { registerGuest, listRegistrations, getRegistrationSummary, getRegistration, changeRegistrationStatus };
