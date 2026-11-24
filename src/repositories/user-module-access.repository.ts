import { Op } from "sequelize";
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

export const userModuleAccessRepository = { listActiveByUserRoleIdsAndModule, listActiveByUserRole };
