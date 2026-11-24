import type { CreationAttributes } from "sequelize";
import type { CustomerAccountRow } from "../models/customer-account.js";
import { CustomerAccount } from "../models/index.js";
import { toPlain, toPlainList } from "../utils/sequelize.js";
import { lockOptions, txOptions, type RepoOptions, type WriteOptions } from "./helpers.js";

/** Explicit projection: never `SELECT *`. */
const attributes = [
  "id",
  "organization_id",
  "name",
  "kind",
  "type",
  "primary_contact_name",
  "primary_contact_email",
  "primary_contact_phone",
  "is_active",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
] as const satisfies readonly (keyof CustomerAccountRow)[];

export type CustomerAccountUpdateValues = Partial<
  Pick<
    CustomerAccountRow,
    "name" | "kind" | "type" | "primary_contact_name" | "primary_contact_email" | "primary_contact_phone" | "is_active" | "updated_by"
  >
>;

async function create(values: CreationAttributes<CustomerAccount>, options: WriteOptions = {}): Promise<CustomerAccountRow> {
  const row = await CustomerAccount.create(values, txOptions(options));
  return row.get({ plain: true });
}

// Every read/write is keyed by organization_id + id. An id alone is never a tenant boundary.
async function findByOrganizationAndId(
  organizationId: string,
  customerAccountId: string,
  options: RepoOptions = {},
): Promise<CustomerAccountRow | null> {
  const row = await CustomerAccount.findOne({
    where: { organization_id: organizationId, id: customerAccountId },
    attributes: [...attributes],
    ...txOptions(options),
    ...lockOptions(options),
  });
  return toPlain<CustomerAccountRow>(row);
}

async function listByOrganization(
  organizationId: string,
  filters: { isActive?: boolean | undefined; limit: number; offset: number },
  options: RepoOptions = {},
): Promise<{ rows: CustomerAccountRow[]; count: number }> {
  const { rows, count } = await CustomerAccount.findAndCountAll({
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
  return { rows: toPlainList<CustomerAccountRow>(rows), count };
}

/** Tenant-scoped update + tenant-scoped read-back inside the same transaction. */
async function updateByOrganizationAndId(
  organizationId: string,
  customerAccountId: string,
  values: CustomerAccountUpdateValues,
  options: WriteOptions = {},
): Promise<CustomerAccountRow | null> {
  await CustomerAccount.update(values, { where: { organization_id: organizationId, id: customerAccountId }, ...txOptions(options) });
  return findByOrganizationAndId(organizationId, customerAccountId, options);
}

export const customerAccountRepository = { create, findByOrganizationAndId, listByOrganization, updateByOrganizationAndId };
