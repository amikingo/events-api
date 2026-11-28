import type { VenueLocationRow } from "../models/venue-location.js";
import { eventRepository } from "../repositories/event.repository.js";
import { venueLocationRepository } from "../repositories/venue-location.repository.js";
import { venueRepository } from "../repositories/venue.repository.js";
import type { VenueLocationSaveInput } from "../validators/venue-location.js";
import { ensureFound, runTransaction } from "./helpers.js";

/** A venue's pin on the map. Every change locks the venue first, so two changes can't both create a pin. */
export type VenueLocationDto = { latitude: number; longitude: number };

const toDto = (row: VenueLocationRow): VenueLocationDto => ({ latitude: row.latitude, longitude: row.longitude });

/** null: the venue has no pin. */
async function getVenueLocation(organizationId: string, venueId: string): Promise<VenueLocationDto | null> {
  ensureFound(await venueRepository.findByOrganizationAndId(organizationId, venueId), "Venue not found");
  const row = await venueLocationRepository.findByVenue(organizationId, venueId);
  return row ? toDto(row) : null;
}

/** What visitors see: the pin of a published event's venue, by both slugs. null without a venue or a pin. */
async function getPublicVenueLocation(organizationSlug: string, eventSlug: string): Promise<VenueLocationDto | null> {
  const event = ensureFound(await eventRepository.findPublishedBySlugs(organizationSlug, eventSlug), "Event not found");
  if (!event.venue_id) return null;
  const row = await venueLocationRepository.findByVenue(event.organization_id, event.venue_id);
  return row ? toDto(row) : null;
}

async function saveVenueLocation(organizationId: string, venueId: string, input: VenueLocationSaveInput, actorId: string | null): Promise<VenueLocationDto> {
  return runTransaction(async (transaction) => {
    ensureFound(await venueRepository.findByOrganizationAndId(organizationId, venueId, { transaction, lock: true }), "Venue not found");
    const values = { latitude: input.latitude, longitude: input.longitude, updated_by: actorId };
    if (await venueLocationRepository.findByVenue(organizationId, venueId, { transaction })) {
      await venueLocationRepository.updateByVenue(organizationId, venueId, values, { transaction });
    } else {
      await venueLocationRepository.create({ ...values, organization_id: organizationId, venue_id: venueId, created_by: actorId }, { transaction });
    }
    return { latitude: input.latitude, longitude: input.longitude };
  });
}

/** Removing a pin that isn't there is fine. */
async function removeVenueLocation(organizationId: string, venueId: string): Promise<null> {
  return runTransaction(async (transaction) => {
    ensureFound(await venueRepository.findByOrganizationAndId(organizationId, venueId, { transaction, lock: true }), "Venue not found");
    await venueLocationRepository.deleteByVenue(organizationId, venueId, { transaction });
    return null;
  });
}

export const venueLocationService = { getVenueLocation, getPublicVenueLocation, saveVenueLocation, removeVenueLocation };
