import { Op, type CreationAttributes, type Transaction } from "sequelize";
import { UserModuleAccess } from "../models/index.js";
import type { UserModuleAccessRow } from "../models/user-module-access.js";
import { toPlainList } from "../utils/sequelize.js";
import { txOptions, type RepoOptions } from "./helpers.js";

const attributes = [
  "id",
  "user_role_id",
  "module_id",
  "can_view",
  "can_create",
  "can_update",
  "can_delete",
  "can_import",
  "can_export",
  "can_notify",
  "is_active",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
] as const satisfies readonly (keyof UserModuleAccessRow)[];

async function listActiveByUserRoleIdsAndModule(
  userRoleIds: readonly string[],
  moduleId: string,
  options: RepoOptions = {},
): Promise<UserModuleAccessRow[]> {
  if (userRoleIds.length === 0) return [];
  const rows = await UserModuleAccess.findAll({
    where: { user_role_id: { [Op.in]: [...userRoleIds] }, module_id: moduleId, is_active: true },
    attributes: [...attributes],
    ...txOptions(options),
  });
  return toPlainList<UserModuleAccessRow>(rows);
}

async function listActiveByUserRole(userRoleId: string, options: RepoOptions = {}): Promise<UserModuleAccessRow[]> {
  const rows = await UserModuleAccess.findAll({
    where: { user_role_id: userRoleId, is_active: true },
    attributes: [...attributes],
    ...txOptions(options),
  });
  return toPlainList<UserModuleAccessRow>(rows);
}

/** How many active overrides an assignment has (the warning when its role changes, Phase 2d). */
async function countActiveByUserRole(userRoleId: string, options: RepoOptions = {}): Promise<number> {
  return UserModuleAccess.count({ where: { user_role_id: userRoleId, is_active: true }, ...txOptions(options) });
}

/** Replaces an assignment's whole override set: delete, then insert, in the caller's transaction (Phase 2d). */
async function replaceForUserRole(
  userRoleId: string,
  values: CreationAttributes<UserModuleAccess>[],
  options: { transaction: Transaction },
): Promise<void> {
  await UserModuleAccess.destroy({ where: { user_role_id: userRoleId }, transaction: options.transaction });
  if (values.length > 0) await UserModuleAccess.bulkCreate(values, { transaction: options.transaction });
}

export const userModuleAccessRepository = { listActiveByUserRoleIdsAndModule, listActiveByUserRole, countActiveByUserRole, replaceForUserRole };
