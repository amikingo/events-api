import type { CreationAttributes } from "sequelize";
import { Person } from "../models/index.js";
import type { PersonRow } from "../models/person.js";
import { toPlain, toPlainList } from "../utils/sequelize.js";
import { lockOptions, txOptions, type RepoOptions, type WriteOptions } from "./helpers.js";
import { personSearchWhere } from "./person-search.js";

/** Explicit projection: never `SELECT *`. */
const attributes = [
  "id",
  "organization_id",
  "first_name",
  "last_name",
  "email",
  "phone",
  "affiliation_name",
  "country",
  "is_active",
  "user_id",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
] as const satisfies readonly (keyof PersonRow)[];

export type PersonUpdateValues = Partial<
  Pick<PersonRow, "first_name" | "last_name" | "email" | "phone" | "affiliation_name" | "country" | "is_active" | "updated_by">
>;

async function create(values: CreationAttributes<Person>, options: WriteOptions = {}): Promise<PersonRow> {
  const row = await Person.create(values, txOptions(options));
  return row.get({ plain: true });
}

// Every read/write is keyed by organization_id + id. An id alone is never a tenant boundary.
async function findByOrganizationAndId(organizationId: string, personId: string, options: RepoOptions = {}): Promise<PersonRow | null> {
  const row = await Person.findOne({
    where: { organization_id: organizationId, id: personId },
    attributes: [...attributes],
    ...txOptions(options),
    ...lockOptions(options),
  });
  return toPlain<PersonRow>(row);
}

/** The profile linked to a Cheche account in this organization (at most one: uq_person_organization_user_id). */
async function findByOrganizationAndUserId(organizationId: string, userId: string, options: RepoOptions = {}): Promise<PersonRow | null> {
  const row = await Person.findOne({
    where: { organization_id: organizationId, user_id: userId },
    attributes: [...attributes],
    ...txOptions(options),
    ...lockOptions(options),
  });
  return toPlain<PersonRow>(row);
}

/**
 * Creates the account's linked profile unless one exists, then returns the one that does (Phase 6). The insert is
 * ON CONFLICT DO NOTHING: when two requests of the same guest race (two events of one organization at once), the
 * second waits on the unique index, inserts nothing, and reads the first one's profile. No error ever aborts the
 * caller's transaction.
 */
async function findOrCreateLinked(
  values: CreationAttributes<Person> & { organization_id: string; user_id: string },
  options: WriteOptions = {},
): Promise<PersonRow> {
  await Person.bulkCreate([values], { ignoreDuplicates: true, ...txOptions(options) });
  const row = await findByOrganizationAndUserId(values.organization_id, values.user_id, options);
  if (!row) throw new Error("The linked guest profile could not be read after it was created");
  return row;
}

async function listByOrganization(
  organizationId: string,
  filters: { q?: string | undefined; phoneVariant?: string | null; isActive?: boolean | undefined; limit: number; offset: number },
  options: RepoOptions = {},
): Promise<{ rows: PersonRow[]; count: number }> {
  const { rows, count } = await Person.findAndCountAll({
    where: {
      organization_id: organizationId,
      ...(typeof filters.isActive === "boolean" ? { is_active: filters.isActive } : {}),
      ...(filters.q ? personSearchWhere(filters.q, filters.phoneVariant ?? null) : {}),
    },
    attributes: [...attributes],
    order: [
      ["is_active", "DESC"],
      ["first_name", "ASC"],
      ["last_name", "ASC"],
      ["id", "ASC"],
    ],
    limit: filters.limit,
    offset: filters.offset,
    ...txOptions(options),
  });
  return { rows: toPlainList<PersonRow>(rows), count };
}

/** Tenant-scoped update + tenant-scoped read-back inside the same transaction. */
async function updateByOrganizationAndId(
  organizationId: string,
  personId: string,
  values: PersonUpdateValues,
  options: WriteOptions = {},
): Promise<PersonRow | null> {
  await Person.update(values, { where: { organization_id: organizationId, id: personId }, ...txOptions(options) });
  return findByOrganizationAndId(organizationId, personId, options);
}

export const personRepository = {
  create,
  findByOrganizationAndId,
  findByOrganizationAndUserId,
  findOrCreateLinked,
  listByOrganization,
  updateByOrganizationAndId,
};
