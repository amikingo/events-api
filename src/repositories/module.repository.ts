import { AppModule } from "../models/index.js";
import type { ModuleRow } from "../models/module.js";
import { toPlain, toPlainList } from "../utils/sequelize.js";
import { txOptions, type RepoOptions } from "./helpers.js";

const attributes = [
  "id",
  "code",
  "module_name",
  "description",
  "parent_id",
  "sno",
  "icon",
  "route_name",
  "is_menu",
  "is_permission",
  "is_active",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
] as const satisfies readonly (keyof ModuleRow)[];

/** Codes are canonical UPPER_SNAKE_CASE (DB CHECK), so one exact-match query is enough. */
async function findActivePermissionByCode(code: string, options: RepoOptions = {}): Promise<ModuleRow | null> {
  const row = await AppModule.findOne({
    where: { code, is_permission: true, is_active: true },
    attributes: [...attributes],
    ...txOptions(options),
  });
  return toPlain<ModuleRow>(row);
}

async function listActiveOrdered(options: RepoOptions = {}): Promise<ModuleRow[]> {
  const rows = await AppModule.findAll({
    where: { is_active: true },
    attributes: [...attributes],
    order: [
      ["sno", "ASC"],
      ["module_name", "ASC"],
      ["code", "ASC"],
    ],
    ...txOptions(options),
  });
  return toPlainList<ModuleRow>(rows);
}

export const moduleRepository = { findActivePermissionByCode, listActiveOrdered };
