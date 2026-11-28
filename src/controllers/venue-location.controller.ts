import type { Request, Response } from "express";
import { getValidated } from "../middleware/validate.js";
import { venueLocationService } from "../services/venue-location.service.js";
import { sendSuccess } from "../utils/http.js";
import {
  getPublicVenueLocationRequest,
  getVenueLocationRequest,
  removeVenueLocationRequest,
  saveVenueLocationRequest,
} from "../validators/venue-location.js";
import { getActorId } from "./helpers.js";

async function getVenueLocation(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, getVenueLocationRequest);
  sendSuccess(res, 200, await venueLocationService.getVenueLocation(params.organizationId, params.venueId), "Venue location retrieved");
}

async function getPublicVenueLocation(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, getPublicVenueLocationRequest);
  sendSuccess(res, 200, await venueLocationService.getPublicVenueLocation(params.organizationSlug, params.eventSlug), "Venue location retrieved");
}

async function saveVenueLocation(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, saveVenueLocationRequest);
  const location = await venueLocationService.saveVenueLocation(params.organizationId, params.venueId, body, getActorId(req));
  sendSuccess(res, 200, location, "Venue location saved");
}

async function removeVenueLocation(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, removeVenueLocationRequest);
  sendSuccess(res, 200, await venueLocationService.removeVenueLocation(params.organizationId, params.venueId), "Venue location removed");
}

export const venueLocationController = { getVenueLocation, getPublicVenueLocation, saveVenueLocation, removeVenueLocation };
