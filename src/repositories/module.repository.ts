import { AppModule } from "../models/index.js";
import type { ModuleRow } from "../models/module.js";
import { toPlain, toPlainList } from "../utils/sequelize.js";
import { lockOptions, txOptions, type RepoOptions, type WriteOptions } from "./helpers.js";

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

/** Every module, switched off ones included, in menu order (the Super Admin's Modules screen, Phase 2d). */
async function listAllOrdered(options: RepoOptions = {}): Promise<ModuleRow[]> {
  const rows = await AppModule.findAll({
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

async function findById(moduleId: string, options: RepoOptions = {}): Promise<ModuleRow | null> {
  const row = await AppModule.findOne({ where: { id: moduleId }, attributes: [...attributes], ...txOptions(options), ...lockOptions(options) });
  return toPlain<ModuleRow>(row);
}

/** Only the display fields can change; codes, routes, parents and on/off stay as the migrations set them. */
export type ModuleDisplayValues = Partial<Pick<ModuleRow, "module_name" | "description" | "sno" | "icon" | "updated_by">>;

async function updateDisplay(moduleId: string, values: ModuleDisplayValues, options: WriteOptions = {}): Promise<ModuleRow | null> {
  await AppModule.update(values, { where: { id: moduleId }, ...txOptions(options) });
  return findById(moduleId, options);
}

export const moduleRepository = { findActivePermissionByCode, listActiveOrdered, listAllOrdered, findById, updateDisplay };
