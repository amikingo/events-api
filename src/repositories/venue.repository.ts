import type { CreationAttributes } from "sequelize";
import { Venue } from "../models/index.js";
import type { VenueRow } from "../models/venue.js";
import { toPlain, toPlainList } from "../utils/sequelize.js";
import { lockOptions, txOptions, type RepoOptions, type WriteOptions } from "./helpers.js";

/** Explicit projection: never `SELECT *`. */
const attributes = [
  "id",
  "organization_id",
  "name",
  "address",
  "city",
  "country",
  "capacity",
  "is_active",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
] as const satisfies readonly (keyof VenueRow)[];

export type VenueUpdateValues = Partial<Pick<VenueRow, "name" | "address" | "city" | "country" | "capacity" | "is_active" | "updated_by">>;

async function create(values: CreationAttributes<Venue>, options: WriteOptions = {}): Promise<VenueRow> {
  const row = await Venue.create(values, txOptions(options));
  return row.get({ plain: true });
}

// Every read/write is keyed by organization_id + id. An id alone is never a tenant boundary.
async function findByOrganizationAndId(organizationId: string, venueId: string, options: RepoOptions = {}): Promise<VenueRow | null> {
  const row = await Venue.findOne({
    where: { organization_id: organizationId, id: venueId },
    attributes: [...attributes],
    ...txOptions(options),
    ...lockOptions(options),
  });
  return toPlain<VenueRow>(row);
}

async function listByOrganization(
  organizationId: string,
  filters: { isActive?: boolean | undefined; limit: number; offset: number },
  options: RepoOptions = {},
): Promise<{ rows: VenueRow[]; count: number }> {
  const { rows, count } = await Venue.findAndCountAll({
    where: {
      organization_id: organizationId,
      ...(typeof filters.isActive === "boolean" ? { is_active: filters.isActive } : {}),
    },
    attributes: [...attributes],
    order: [
      ["is_active", "DESC"],
      ["name", "ASC"],
      ["id", "ASC"],
    ],
    limit: filters.limit,
    offset: filters.offset,
    ...txOptions(options),
  });
  return { rows: toPlainList<VenueRow>(rows), count };
}

/** Tenant-scoped update + tenant-scoped read-back inside the same transaction. */
async function updateByOrganizationAndId(
  organizationId: string,
  venueId: string,
  values: VenueUpdateValues,
  options: WriteOptions = {},
): Promise<VenueRow | null> {
  await Venue.update(values, { where: { organization_id: organizationId, id: venueId }, ...txOptions(options) });
  return findByOrganizationAndId(organizationId, venueId, options);
}

export const venueRepository = { create, findByOrganizationAndId, listByOrganization, updateByOrganizationAndId };
