import type { Request, Response } from "express";
import { getValidated } from "../middleware/validate.js";
import { eventService } from "../services/event.service.js";
import { sendList, sendSuccess } from "../utils/http.js";
import { changeEventStatusRequest, createEventRequest, getEventRequest, listEventsRequest, updateEventRequest } from "../validators/event.js";
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

export const eventController = { createEvent, listEvents, getEvent, updateEvent, changeEventStatus };
