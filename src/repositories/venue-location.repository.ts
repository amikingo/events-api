import type { CreationAttributes } from "sequelize";
import { VenueLocation } from "../models/index.js";
import type { VenueLocationRow } from "../models/venue-location.js";
import { toPlain } from "../utils/sequelize.js";
import { txOptions, type RepoOptions, type WriteOptions } from "./helpers.js";

/** Explicit projection: never `SELECT *`. */
const attributes = [
  "id",
  "organization_id",
  "venue_id",
  "latitude",
  "longitude",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
] as const satisfies readonly (keyof VenueLocationRow)[];

export type VenueLocationUpdateValues = Partial<Pick<VenueLocationRow, "latitude" | "longitude" | "updated_by">>;

// A venue's pin is keyed by organization_id + venue_id. An id alone is never a tenant boundary.
async function findByVenue(organizationId: string, venueId: string, options: RepoOptions = {}): Promise<VenueLocationRow | null> {
  const row = await VenueLocation.findOne({
    where: { organization_id: organizationId, venue_id: venueId },
    attributes: [...attributes],
    ...txOptions(options),
  });
  return toPlain<VenueLocationRow>(row);
}

async function create(values: CreationAttributes<VenueLocation>, options: WriteOptions = {}): Promise<VenueLocationRow> {
  const row = await VenueLocation.create(values, txOptions(options));
  return row.get({ plain: true });
}

async function updateByVenue(organizationId: string, venueId: string, values: VenueLocationUpdateValues, options: WriteOptions = {}): Promise<void> {
  await VenueLocation.update(values, { where: { organization_id: organizationId, venue_id: venueId }, ...txOptions(options) });
}

/** Removes the pin; true when there was one. */
async function deleteByVenue(organizationId: string, venueId: string, options: WriteOptions = {}): Promise<boolean> {
  const count = await VenueLocation.destroy({ where: { organization_id: organizationId, venue_id: venueId }, ...txOptions(options) });
  return count > 0;
}

export const venueLocationRepository = { findByVenue, create, updateByVenue, deleteByVenue };
