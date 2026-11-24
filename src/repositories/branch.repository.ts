import type { CreationAttributes } from "sequelize";
import { Branch } from "../models/index.js";
import type { BranchRow } from "../models/branch.js";
import { toPlain, toPlainList } from "../utils/sequelize.js";
import { lockOptions, txOptions, type RepoOptions, type WriteOptions } from "./helpers.js";

/** Explicit projection: never `SELECT *`, never leak columns added later by accident. */
const attributes = [
  "id",
  "organization_id",
  "code",
  "name",
  "description",
  "is_default",
  "is_active",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
] as const satisfies readonly (keyof BranchRow)[];

export type BranchUpdateValues = Partial<
  Pick<BranchRow, "code" | "name" | "description" | "is_active" | "is_default" | "updated_by">
>;

async function create(values: CreationAttributes<Branch>, options: WriteOptions = {}): Promise<BranchRow> {
  const row = await Branch.create(values, txOptions(options));
  return row.get({ plain: true });
}

// Every read/write is keyed by organization_id + id. An id alone is never a tenant boundary.
async function findByOrganizationAndId(
  organizationId: string,
  branchId: string,
  options: RepoOptions = {},
): Promise<BranchRow | null> {
  const row = await Branch.findOne({
    where: { organization_id: organizationId, id: branchId },
    attributes: [...attributes],
    ...txOptions(options),
    ...lockOptions(options),
  });
  return toPlain<BranchRow>(row);
}

async function findByOrganizationAndCode(
  organizationId: string,
  code: string,
  options: RepoOptions = {},
): Promise<BranchRow | null> {
  const row = await Branch.findOne({
    where: { organization_id: organizationId, code },
    attributes: [...attributes],
    ...txOptions(options),
  });
  return toPlain<BranchRow>(row);
}

async function findActiveDefaultByOrganization(organizationId: string, options: RepoOptions = {}): Promise<BranchRow | null> {
  const row = await Branch.findOne({
    where: { organization_id: organizationId, is_active: true, is_default: true },
    attributes: [...attributes],
    ...txOptions(options),
    ...lockOptions(options),
  });
  return toPlain<BranchRow>(row);
}

async function listByOrganization(
  organizationId: string,
  filters: { isActive?: boolean | undefined; limit: number; offset: number },
  options: RepoOptions = {},
): Promise<{ rows: BranchRow[]; count: number }> {
  const { rows, count } = await Branch.findAndCountAll({
    where: {
      organization_id: organizationId,
      ...(typeof filters.isActive === "boolean" ? { is_active: filters.isActive } : {}),
    },
    attributes: [...attributes],
    order: [
      ["is_active", "DESC"],
      ["is_default", "DESC"],
      ["code", "ASC"],
      ["id", "ASC"],
    ],
    limit: filters.limit,
    offset: filters.offset,
    ...txOptions(options),
  });
  return { rows: toPlainList<BranchRow>(rows), count };
}

async function countActiveByOrganization(organizationId: string, options: RepoOptions = {}): Promise<number> {
  return Branch.count({ where: { organization_id: organizationId, is_active: true }, ...txOptions(options) });
}

/** Tenant-scoped update + tenant-scoped read-back inside the same transaction. */
async function updateByOrganizationAndId(
  organizationId: string,
  branchId: string,
  values: BranchUpdateValues,
  options: WriteOptions = {},
): Promise<BranchRow | null> {
  await Branch.update(values, { where: { organization_id: organizationId, id: branchId }, ...txOptions(options) });
  return findByOrganizationAndId(organizationId, branchId, options);
}

export const branchRepository = {
  create,
  findByOrganizationAndId,
  findByOrganizationAndCode,
  findActiveDefaultByOrganization,
  listByOrganization,
  countActiveByOrganization,
  updateByOrganizationAndId,
};
