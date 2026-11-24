import type { Request, Response } from "express";
import { getValidated } from "../middleware/validate.js";
import { venueService } from "../services/venue.service.js";
import { sendList, sendSuccess } from "../utils/http.js";
import { changeVenueStatusRequest, createVenueRequest, getVenueRequest, listVenuesRequest, updateVenueRequest } from "../validators/venue.js";
import { getActorId } from "./helpers.js";

async function createVenue(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, createVenueRequest);
  const venue = await venueService.createVenue(params.organizationId, body, getActorId(req));
  sendSuccess(res, 201, venue, "Venue created");
}

async function listVenues(req: Request, res: Response): Promise<void> {
  const { params, query } = getValidated(req, listVenuesRequest);
  const { rows, count } = await venueService.listVenues(params.organizationId, query);
  sendList(res, 200, rows, { count, page: query.page, pageSize: query.pageSize }, "Venues retrieved");
}

async function getVenue(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, getVenueRequest);
  const venue = await venueService.getVenue(params.organizationId, params.venueId);
  sendSuccess(res, 200, venue, "Venue retrieved");
}

async function updateVenue(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, updateVenueRequest);
  const venue = await venueService.updateVenue(params.organizationId, params.venueId, body, getActorId(req));
  sendSuccess(res, 200, venue, "Venue updated");
}

async function changeVenueStatus(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, changeVenueStatusRequest);
  const venue = await venueService.changeVenueStatus(params.organizationId, params.venueId, body.is_active, getActorId(req));
  sendSuccess(res, 200, venue, "Venue status updated");
}

export const venueController = { createVenue, listVenues, getVenue, updateVenue, changeVenueStatus };
