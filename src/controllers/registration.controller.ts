import type { Request, Response } from "express";
import { getValidated } from "../middleware/validate.js";
import { registrationService } from "../services/registration.service.js";
import { sendList, sendSuccess } from "../utils/http.js";
import {
  changeRegistrationStatusRequest,
  changeRegistrationTicketTypeRequest,
  createRegistrationRequest,
  exportRegistrationsRequest,
  getRegistrationRequest,
  getRegistrationSummaryRequest,
  listRegistrationsRequest,
} from "../validators/registration.js";
import { getActorId } from "./helpers.js";

/**
 * 201 when a place was taken (new or reactivated); 200 when the same confirmed registration already existed, or when
 * the same request (same Idempotency-Key) was already processed.
 */
async function registerGuest(req: Request, res: Response): Promise<void> {
  const { params, headers, body } = getValidated(req, createRegistrationRequest);
  const { registration, outcome } = await registrationService.registerGuest(
    params.organizationId,
    params.eventId,
    body,
    getActorId(req),
    headers["idempotency-key"],
  );
  if (outcome === "REPLAYED") {
    sendSuccess(res, 200, registration, "Same request already processed");
    return;
  }
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

/** Move a confirmed guest to another ticket type; 200 either way, the message says whether anything changed. */
async function changeRegistrationTicketType(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, changeRegistrationTicketTypeRequest);
  const { registration, changed } = await registrationService.changeRegistrationTicketType(
    params.organizationId,
    params.eventId,
    params.registrationId,
    body.ticket_type_id,
    getActorId(req),
  );
  sendSuccess(res, 200, registration, changed ? "Ticket type changed" : "Ticket type unchanged");
}

/** The guest list as a CSV download: the only non-JSON reply (errors still use the JSON envelope). */
async function exportRegistrations(req: Request, res: Response): Promise<void> {
  const { params, query } = getValidated(req, exportRegistrationsRequest);
  const { filename, csv } = await registrationService.exportRegistrations(params.organizationId, params.eventId, query);
  res
    .status(200)
    .set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    })
    .send(csv);
}

export const registrationController = {
  registerGuest,
  listRegistrations,
  getRegistrationSummary,
  getRegistration,
  changeRegistrationStatus,
  changeRegistrationTicketType,
  exportRegistrations,
};
