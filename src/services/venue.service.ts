import type { VenueRow } from "../models/venue.js";
import { organizationRepository } from "../repositories/organization.repository.js";
import { venueRepository } from "../repositories/venue.repository.js";
import { buildPagination } from "../utils/pagination.js";
import { pickDefined } from "../utils/patch.js";
import type { VenueCreateInput, VenueListQuery, VenueUpdateInput } from "../validators/venue.js";
import { ensureFound, runTransaction } from "./helpers.js";

/**
 * Reusable physical locations (spec §4). Deactivated rather than deleted, so events that reference a venue keep
 * their history.
 */
const UPDATABLE_FIELDS = ["name", "address", "city", "country", "capacity"] as const;

async function createVenue(organizationId: string, input: VenueCreateInput, actorId: string | null): Promise<VenueRow> {
  return runTransaction(async (transaction) => {
    ensureFound(await organizationRepository.findById(organizationId, { transaction }), "Organization not found");
    return venueRepository.create(
      {
        organization_id: organizationId,
        name: input.name,
        address: input.address ?? null,
        city: input.city ?? null,
        country: input.country ?? null,
        capacity: input.capacity ?? null,
        is_active: input.is_active ?? true,
        created_by: actorId,
        updated_by: actorId,
      },
      { transaction },
    );
  });
}

async function listVenues(organizationId: string, query: VenueListQuery): Promise<{ rows: VenueRow[]; count: number }> {
  const { limit, offset } = buildPagination(query);
  return venueRepository.listByOrganization(organizationId, { isActive: query.is_active, limit, offset });
}

async function getVenue(organizationId: string, venueId: string): Promise<VenueRow> {
  return ensureFound(await venueRepository.findByOrganizationAndId(organizationId, venueId), "Venue not found");
}

async function updateVenue(organizationId: string, venueId: string, input: VenueUpdateInput, actorId: string | null): Promise<VenueRow> {
  return runTransaction(async (transaction) => {
    ensureFound(await venueRepository.findByOrganizationAndId(organizationId, venueId, { transaction, lock: true }), "Venue not found");
    const updated = await venueRepository.updateByOrganizationAndId(
      organizationId,
      venueId,
      { ...pickDefined(input, UPDATABLE_FIELDS), updated_by: actorId },
      { transaction },
    );
    return ensureFound(updated, "Venue not found");
  });
}

async function changeVenueStatus(organizationId: string, venueId: string, isActive: boolean, actorId: string | null): Promise<VenueRow> {
  return runTransaction(async (transaction) => {
    ensureFound(await venueRepository.findByOrganizationAndId(organizationId, venueId, { transaction, lock: true }), "Venue not found");
    const updated = await venueRepository.updateByOrganizationAndId(
      organizationId,
      venueId,
      { is_active: isActive, updated_by: actorId },
      { transaction },
    );
    return ensureFound(updated, "Venue not found");
  });
}

export const venueService = { createVenue, listVenues, getVenue, updateVenue, changeVenueStatus };
