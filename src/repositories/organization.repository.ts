import type { CreationAttributes } from "sequelize";
import { Organization } from "../models/index.js";
import type { OrganizationRow } from "../models/organization.js";
import { toPlain, toPlainList } from "../utils/sequelize.js";
import { lockOptions, txOptions, type RepoOptions, type WriteOptions } from "./helpers.js";

const attributes = [
  "id",
  "name",
  "slug",
  "description",
  "has_branches",
  "country",
  "timezone",
  "default_currency",
  "is_active",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
] as const satisfies readonly (keyof OrganizationRow)[];

async function create(values: CreationAttributes<Organization>, options: WriteOptions = {}): Promise<OrganizationRow> {
  const row = await Organization.create(values, txOptions(options));
  return row.get({ plain: true });
}

async function findById(id: string, options: RepoOptions = {}): Promise<OrganizationRow | null> {
  const row = await Organization.findByPk(id, {
    attributes: [...attributes],
    ...txOptions(options),
    ...lockOptions(options),
  });
  return toPlain<OrganizationRow>(row);
}

async function findBySlug(slug: string, options: RepoOptions = {}): Promise<OrganizationRow | null> {
  const row = await Organization.findOne({ where: { slug }, attributes: [...attributes], ...txOptions(options) });
  return toPlain<OrganizationRow>(row);
}

async function list(
  filters: { isActive?: boolean | undefined; limit: number; offset: number },
  options: RepoOptions = {},
): Promise<{ rows: OrganizationRow[]; count: number }> {
  const { rows, count } = await Organization.findAndCountAll({
    where: typeof filters.isActive === "boolean" ? { is_active: filters.isActive } : {},
    attributes: [...attributes],
    order: [
      ["name", "ASC"],
      ["id", "ASC"],
    ],
    limit: filters.limit,
    offset: filters.offset,
    ...txOptions(options),
  });
  return { rows: toPlainList<OrganizationRow>(rows), count };
}

/** Turns branches on (idempotent): used when an organization without branches adds one. */
async function enableBranches(id: string, actorId: string | null, options: WriteOptions = {}): Promise<void> {
  await Organization.update({ has_branches: true, updated_by: actorId }, { where: { id, has_branches: false }, ...txOptions(options) });
}

export type OrganizationSettingsValues = Partial<Pick<OrganizationRow, "country" | "timezone" | "default_currency" | "updated_by">>;

/** Updates the organization's defaults and reads it back inside the same transaction. */
async function updateSettings(id: string, values: OrganizationSettingsValues, options: WriteOptions = {}): Promise<OrganizationRow | null> {
  await Organization.update(values, { where: { id }, ...txOptions(options) });
  return findById(id, options);
}

export const organizationRepository = { create, findById, findBySlug, list, enableBranches, updateSettings };
