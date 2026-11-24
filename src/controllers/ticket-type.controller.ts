import type { Request, Response } from "express";
import { getValidated } from "../middleware/validate.js";
import { ticketTypeService } from "../services/ticket-type.service.js";
import { sendSuccess } from "../utils/http.js";
import {
  changeTicketTypeStatusRequest,
  createTicketTypeRequest,
  listTicketTypesRequest,
  updateTicketTypeRequest,
} from "../validators/ticket-type.js";
import { getActorId } from "./helpers.js";

async function createTicketType(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, createTicketTypeRequest);
  const ticketType = await ticketTypeService.createTicketType(params.organizationId, params.eventId, body, getActorId(req));
  sendSuccess(res, 201, ticketType, "Ticket type created");
}

async function listTicketTypes(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, listTicketTypesRequest);
  const ticketTypes = await ticketTypeService.listTicketTypes(params.organizationId, params.eventId);
  sendSuccess(res, 200, ticketTypes, "Ticket types retrieved");
}

async function updateTicketType(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, updateTicketTypeRequest);
  const ticketType = await ticketTypeService.updateTicketType(params.organizationId, params.eventId, params.ticketTypeId, body, getActorId(req));
  sendSuccess(res, 200, ticketType, "Ticket type updated");
}

async function changeTicketTypeStatus(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, changeTicketTypeStatusRequest);
  const ticketType = await ticketTypeService.changeTicketTypeStatus(
    params.organizationId,
    params.eventId,
    params.ticketTypeId,
    body.is_active,
    getActorId(req),
  );
  sendSuccess(res, 200, ticketType, "Ticket type status updated");
}

export const ticketTypeController = { createTicketType, listTicketTypes, updateTicketType, changeTicketTypeStatus };
