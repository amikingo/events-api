import type { Request, Response } from "express";
import { ValidationAppError } from "../errors/app-errors.js";
import { getValidated } from "../middleware/validate.js";
import { ticketDesignService } from "../services/ticket-design.service.js";
import { sendSuccess } from "../utils/http.js";
import {
  getPublicTicketDesignRequest,
  getTicketDesignRequest,
  removeTicketDesignRequest,
  removeTicketImageRequest,
  saveTicketDesignRequest,
  setTicketImageRequest,
} from "../validators/ticket-design.js";
import { getActorId } from "./helpers.js";

async function getTicketDesign(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, getTicketDesignRequest);
  sendSuccess(res, 200, await ticketDesignService.getTicketDesign(params.organizationId, params.eventId), "Ticket design retrieved");
}

async function getPublicTicketDesign(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, getPublicTicketDesignRequest);
  sendSuccess(res, 200, await ticketDesignService.getPublicTicketDesign(params.organizationSlug, params.eventSlug), "Ticket design retrieved");
}

async function saveTicketDesign(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, saveTicketDesignRequest);
  const design = await ticketDesignService.saveTicketDesign(params.organizationId, params.eventId, body, getActorId(req));
  sendSuccess(res, 200, design, "Ticket design saved");
}

async function removeTicketDesign(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, removeTicketDesignRequest);
  sendSuccess(res, 200, await ticketDesignService.removeTicketDesign(params.organizationId, params.eventId, getActorId(req)), "Ticket design removed");
}

async function setTicketImage(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, setTicketImageRequest);
  if (!req.file) {
    throw new ValidationAppError("Request validation failed", {
      issues: [{ path: "body.file", message: "Attach the image as multipart/form-data in the field 'file'", code: "file_required" }],
    });
  }
  const design = await ticketDesignService.setTicketImage(
    params.organizationId,
    params.eventId,
    params.slot,
    { bytes: req.file.buffer, originalName: req.file.originalname },
    getActorId(req),
  );
  sendSuccess(res, 200, design, "Ticket image updated");
}

async function removeTicketImage(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, removeTicketImageRequest);
  const design = await ticketDesignService.removeTicketImage(params.organizationId, params.eventId, params.slot, getActorId(req));
  sendSuccess(res, 200, design, "Ticket image removed");
}

export const ticketDesignController = {
  getTicketDesign,
  getPublicTicketDesign,
  saveTicketDesign,
  removeTicketDesign,
  setTicketImage,
  removeTicketImage,
};
