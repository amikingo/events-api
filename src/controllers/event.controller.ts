import type { Request, Response } from "express";
import { ValidationAppError } from "../errors/app-errors.js";
import { getValidated } from "../middleware/validate.js";
import { eventCoverService } from "../services/event-cover.service.js";
import { eventService } from "../services/event.service.js";
import { sendList, sendSuccess } from "../utils/http.js";
import {
  changeEventStatusRequest,
  createEventRequest,
  getEventRequest,
  listEventsRequest,
  removeEventCoverRequest,
  setEventCoverRequest,
  updateEventRequest,
} from "../validators/event.js";
import { getActorId } from "./helpers.js";

async function createEvent(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, createEventRequest);
  const event = await eventService.createEvent(params.organizationId, body, getActorId(req));
  sendSuccess(res, 201, event, "Event created");
}

async function listEvents(req: Request, res: Response): Promise<void> {
  const { params, query } = getValidated(req, listEventsRequest);
  const { rows, count } = await eventService.listEvents(params.organizationId, query);
  sendList(res, 200, rows, { count, page: query.page, pageSize: query.pageSize }, "Events retrieved");
}

async function getEvent(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, getEventRequest);
  const event = await eventService.getEvent(params.organizationId, params.eventId);
  sendSuccess(res, 200, event, "Event retrieved");
}

async function updateEvent(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, updateEventRequest);
  const event = await eventService.updateEvent(params.organizationId, params.eventId, body, getActorId(req));
  sendSuccess(res, 200, event, "Event updated");
}

async function changeEventStatus(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, changeEventStatusRequest);
  const event = await eventService.changeEventStatus(params.organizationId, params.eventId, body.status, getActorId(req));
  sendSuccess(res, 200, event, "Event status updated");
}

async function setEventCover(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, setEventCoverRequest);
  if (!req.file) {
    throw new ValidationAppError("Request validation failed", {
      issues: [{ path: "body.file", message: "Attach the image as multipart/form-data in the field 'file'", code: "file_required" }],
    });
  }
  const event = await eventCoverService.setEventCover(
    params.organizationId,
    params.eventId,
    { bytes: req.file.buffer, originalName: req.file.originalname },
    getActorId(req),
  );
  sendSuccess(res, 200, event, "Event cover updated");
}

async function removeEventCover(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, removeEventCoverRequest);
  const event = await eventCoverService.removeEventCover(params.organizationId, params.eventId, getActorId(req));
  sendSuccess(res, 200, event, "Event cover removed");
}

export const eventController = { createEvent, listEvents, getEvent, updateEvent, changeEventStatus, setEventCover, removeEventCover };
