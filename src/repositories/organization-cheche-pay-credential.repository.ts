import type { CreationAttributes } from "sequelize";
import { OrganizationChechePayCredential } from "../models/index.js";
import type { OrganizationChechePayCredentialRow } from "../models/organization-cheche-pay-credential.js";
import { toPlain } from "../utils/sequelize.js";
import { lockOptions, txOptions, type RepoOptions, type WriteOptions } from "./helpers.js";

/** Explicit projection. The encrypted secrets are read only to be decrypted by the credential service. */
const attributes = [
  "id",
  "organization_id",
  "key_mode",
  "secret_key_encrypted",
  "secret_key_last4",
  "webhook_secret_encrypted",
  "is_active",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
] as const satisfies readonly (keyof OrganizationChechePayCredentialRow)[];

export type ChechePayCredentialUpdateValues = Partial<
  Pick<OrganizationChechePayCredentialRow, "key_mode" | "secret_key_encrypted" | "secret_key_last4" | "webhook_secret_encrypted" | "is_active" | "updated_by">
>;

async function create(values: CreationAttributes<OrganizationChechePayCredential>, options: WriteOptions = {}): Promise<OrganizationChechePayCredentialRow> {
  const row = await OrganizationChechePayCredential.create(values, txOptions(options));
  return row.get({ plain: true });
}

/** One organizer's keys (one row per organization). */
async function findByOrganization(organizationId: string, options: RepoOptions = {}): Promise<OrganizationChechePayCredentialRow | null> {
  const row = await OrganizationChechePayCredential.findOne({
    where: { organization_id: organizationId },
    attributes: [...attributes],
    ...txOptions(options),
    ...lockOptions(options),
  });
  return toPlain<OrganizationChechePayCredentialRow>(row);
}

async function updateByOrganization(organizationId: string, values: ChechePayCredentialUpdateValues, options: WriteOptions = {}): Promise<void> {
  await OrganizationChechePayCredential.update(values, { where: { organization_id: organizationId }, ...txOptions(options) });
}

/** Removes the keys for good; true when there were any. */
async function deleteByOrganization(organizationId: string, options: WriteOptions = {}): Promise<boolean> {
  const count = await OrganizationChechePayCredential.destroy({ where: { organization_id: organizationId }, ...txOptions(options) });
  return count > 0;
}

export const organizationChechePayCredentialRepository = { create, findByOrganization, updateByOrganization, deleteByOrganization };
