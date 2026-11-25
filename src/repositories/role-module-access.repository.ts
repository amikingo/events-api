import { Op, type CreationAttributes, type Transaction } from "sequelize";
import { AppModule, RoleModuleAccess } from "../models/index.js";
import type { ModuleRow } from "../models/module.js";
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

/** A grant with the module it is for (code and name), for showing what a role may do. */
export type RoleGrantRow = RoleModuleAccessRow & { module: Pick<ModuleRow, "code" | "module_name" | "sno"> };

async function listWithModulesByRoleIds(roleIds: readonly string[], options: RepoOptions = {}): Promise<RoleGrantRow[]> {
  if (roleIds.length === 0) return [];
  const rows = await RoleModuleAccess.findAll({
    where: { role_id: { [Op.in]: [...roleIds] } },
    attributes: [...attributes],
    include: [{ model: AppModule, as: "module", required: true, attributes: ["code", "module_name", "sno"] }],
    order: [[{ model: AppModule, as: "module" }, "sno", "ASC"]],
    ...txOptions(options),
  });
  return toPlainList<RoleGrantRow>(rows);
}

/** Replaces a role's whole grant set: delete, then insert, in the caller's transaction. */
async function replaceForRole(roleId: string, values: CreationAttributes<RoleModuleAccess>[], options: { transaction: Transaction }): Promise<void> {
  await RoleModuleAccess.destroy({ where: { role_id: roleId }, transaction: options.transaction });
  if (values.length > 0) await RoleModuleAccess.bulkCreate(values, { transaction: options.transaction });
}

export const roleModuleAccessRepository = { listByRoleIdsAndModule, listByRoleId, listWithModulesByRoleIds, bulkCreate, replaceForRole };
