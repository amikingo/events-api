import type { CreationAttributes } from "sequelize";
import { Role } from "../models/index.js";
import type { RoleRow } from "../models/role.js";
import { toPlain, toPlainList } from "../utils/sequelize.js";
import { txOptions, type RepoOptions, type WriteOptions } from "./helpers.js";

const attributes = [
  "id",
  "organization_id",
  "code",
  "name",
  "description",
  "is_active",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
] as const satisfies readonly (keyof RoleRow)[];

async function findPlatformRoleByCode(code: string, options: RepoOptions = {}): Promise<RoleRow | null> {
  const row = await Role.findOne({ where: { organization_id: null, code }, attributes: [...attributes], ...txOptions(options) });
  return toPlain<RoleRow>(row);
}

// Tenant roles are keyed by organization_id + code. A code alone is never a tenant boundary.
async function findByOrganizationAndCode(organizationId: string, code: string, options: RepoOptions = {}): Promise<RoleRow | null> {
  const row = await Role.findOne({ where: { organization_id: organizationId, code }, attributes: [...attributes], ...txOptions(options) });
  return toPlain<RoleRow>(row);
}

async function create(values: CreationAttributes<Role>, options: WriteOptions = {}): Promise<RoleRow> {
  const row = await Role.create(values, txOptions(options));
  return row.get({ plain: true });
}

// Tenant roles are keyed by organization_id + id: a platform role (organization_id NULL) is never found here.
async function findByOrganizationAndId(organizationId: string, roleId: string, options: RepoOptions = {}): Promise<RoleRow | null> {
  const row = await Role.findOne({ where: { organization_id: organizationId, id: roleId }, attributes: [...attributes], ...txOptions(options) });
  return toPlain<RoleRow>(row);
}

async function listByOrganization(organizationId: string, options: RepoOptions = {}): Promise<RoleRow[]> {
  const rows = await Role.findAll({
    where: { organization_id: organizationId },
    attributes: [...attributes],
    order: [
      ["is_active", "DESC"],
      ["code", "ASC"],
    ],
    ...txOptions(options),
  });
  return toPlainList<RoleRow>(rows);
}

export const roleRepository = { findPlatformRoleByCode, findByOrganizationAndCode, findByOrganizationAndId, listByOrganization, create };
