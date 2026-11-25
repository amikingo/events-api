import type { Request, Response } from "express";
import { getValidated } from "../middleware/validate.js";
import { publicEventService } from "../services/public-event.service.js";
import { sendList, sendSuccess } from "../utils/http.js";
import { getPublicEventRequest, listPublicEventsRequest } from "../validators/public-event.js";

async function listCatalog(req: Request, res: Response): Promise<void> {
  const { query } = getValidated(req, listPublicEventsRequest);
  const { rows, count } = await publicEventService.listCatalog(query);
  sendList(res, 200, rows, { count, page: query.page, pageSize: query.pageSize }, "Events retrieved");
}

async function getPublicEvent(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, getPublicEventRequest);
  const event = await publicEventService.getPublicEvent(params.organizationSlug, params.eventSlug);
  sendSuccess(res, 200, event, "Event retrieved");
}

export const publicEventController = { listCatalog, getPublicEvent };
