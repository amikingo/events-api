import { Op, type CreationAttributes } from "sequelize";
import { RoleModuleAccess } from "../models/index.js";
import type { RoleModuleAccessRow } from "../models/role-module-access.js";
import { toPlainList } from "../utils/sequelize.js";
import { txOptions, type RepoOptions, type WriteOptions } from "./helpers.js";

const attributes = [
  "id",
  "role_id",
  "module_id",
  "can_view",
  "can_create",
  "can_update",
  "can_delete",
  "can_import",
  "can_export",
  "can_notify",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
] as const satisfies readonly (keyof RoleModuleAccessRow)[];

/** Batch read: one query for every applicable role, instead of one query per assignment. */
async function listByRoleIdsAndModule(
  roleIds: readonly string[],
  moduleId: string,
  options: RepoOptions = {},
): Promise<RoleModuleAccessRow[]> {
  if (roleIds.length === 0) return [];
  const rows = await RoleModuleAccess.findAll({
    where: { role_id: { [Op.in]: [...roleIds] }, module_id: moduleId },
    attributes: [...attributes],
    ...txOptions(options),
  });
  return toPlainList<RoleModuleAccessRow>(rows);
}

async function listByRoleId(roleId: string, options: RepoOptions = {}): Promise<RoleModuleAccessRow[]> {
  const rows = await RoleModuleAccess.findAll({ where: { role_id: roleId }, attributes: [...attributes], ...txOptions(options) });
  return toPlainList<RoleModuleAccessRow>(rows);
}

async function bulkCreate(values: CreationAttributes<RoleModuleAccess>[], options: WriteOptions = {}): Promise<void> {
  if (values.length === 0) return;
  await RoleModuleAccess.bulkCreate(values, txOptions(options));
}

export const roleModuleAccessRepository = { listByRoleIdsAndModule, listByRoleId, bulkCreate };
