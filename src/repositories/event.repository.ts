import { Op, type CreationAttributes, type Transaction } from "sequelize";
import type { EventRow, EventStatus, EventVisibility } from "../models/event.js";
import { AppEvent } from "../models/index.js";
import { toPlain, toPlainList } from "../utils/sequelize.js";
import { acquireAdvisoryXactLock, lockOptions, txOptions, type RepoOptions, type WriteOptions } from "./helpers.js";

/** Explicit projection: never `SELECT *`. */
const attributes = [
  "id",
  "organization_id",
  "branch_id",
  "customer_account_id",
  "venue_id",
  "cover_file_id",
  "name",
  "slug",
  "description",
  "starts_at",
  "ends_at",
  "timezone",
  "status",
  "capacity",
  "registration_opens_at",
  "registration_closes_at",
  "visibility",
  "category",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
] as const satisfies readonly (keyof EventRow)[];

export type EventUpdateValues = Partial<Omit<EventRow, "id" | "organization_id" | "created_at" | "updated_at" | "created_by">>;

async function create(values: CreationAttributes<AppEvent>, options: WriteOptions = {}): Promise<EventRow> {
  const row = await AppEvent.create(values, txOptions(options));
  return row.get({ plain: true });
}

// Every read/write is keyed by organization_id + id. An id alone is never a tenant boundary.
async function findByOrganizationAndId(organizationId: string, eventId: string, options: RepoOptions = {}): Promise<EventRow | null> {
  const row = await AppEvent.findOne({
    where: { organization_id: organizationId, id: eventId },
    attributes: [...attributes],
    ...txOptions(options),
    ...lockOptions(options),
  });
  return toPlain<EventRow>(row);
}

async function findByOrganizationAndSlug(organizationId: string, slug: string, options: RepoOptions = {}): Promise<EventRow | null> {
  const row = await AppEvent.findOne({ where: { organization_id: organizationId, slug }, attributes: [...attributes], ...txOptions(options) });
  return toPlain<EventRow>(row);
}

/** Slugs in the organization equal to `base` or of the form `base-…`, for picking the next free suffix. */
async function listSlugsWithPrefix(organizationId: string, base: string, options: RepoOptions = {}): Promise<string[]> {
  const rows = await AppEvent.findAll({
    where: { organization_id: organizationId, [Op.or]: [{ slug: base }, { slug: { [Op.like]: `${base}-%` } }] },
    attributes: ["slug"],
    ...txOptions(options),
  });
  return rows.map((row) => row.slug);
}

/** Serializes slug choice per organization until the transaction ends, so two new events never pick the same slug. */
async function lockSlugsOfOrganization(organizationId: string, options: { transaction: Transaction }): Promise<void> {
  await acquireAdvisoryXactLock("event_slug", organizationId, options);
}

async function listByOrganization(
  organizationId: string,
  filters: { status?: EventStatus | undefined; visibility?: EventVisibility | undefined; limit: number; offset: number },
  options: RepoOptions = {},
): Promise<{ rows: EventRow[]; count: number }> {
  const { rows, count } = await AppEvent.findAndCountAll({
    where: {
      organization_id: organizationId,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.visibility ? { visibility: filters.visibility } : {}),
    },
    attributes: [...attributes],
    // Dated events by start time; undated drafts last, newest first.
    order: [
      ["starts_at", "ASC NULLS LAST"],
      ["created_at", "DESC"],
      ["id", "ASC"],
    ],
    limit: filters.limit,
    offset: filters.offset,
    ...txOptions(options),
  });
  return { rows: toPlainList<EventRow>(rows), count };
}

/** Tenant-scoped update + tenant-scoped read-back inside the same transaction. */
async function updateByOrganizationAndId(
  organizationId: string,
  eventId: string,
  values: EventUpdateValues,
  options: WriteOptions = {},
): Promise<EventRow | null> {
  await AppEvent.update(values, { where: { organization_id: organizationId, id: eventId }, ...txOptions(options) });
  return findByOrganizationAndId(organizationId, eventId, options);
}

export const eventRepository = {
  create,
  findByOrganizationAndId,
  findByOrganizationAndSlug,
  listSlugsWithPrefix,
  lockSlugsOfOrganization,
  listByOrganization,
  updateByOrganizationAndId,
};
