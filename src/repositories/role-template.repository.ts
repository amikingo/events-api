import { Op, type CreationAttributes, type Transaction } from "sequelize";
import { AppModule, RoleTemplate, RoleTemplateModuleAccess } from "../models/index.js";
import type { ModuleRow } from "../models/module.js";
import type { RoleTemplateRow } from "../models/role-template.js";
import type { RoleTemplateModuleAccessRow } from "../models/role-template-module-access.js";
import { toPlain, toPlainList } from "../utils/sequelize.js";
import { activeModuleIds, lockOptions, txOptions, type RepoOptions, type WriteOptions } from "./helpers.js";

/** Role templates (Phase 2d): a platform library, never tenant data. Explicit projections: never `SELECT *`. */
const attributes = [
  "id",
  "code",
  "name",
  "description",
  "is_active",
  "for_new_organizations",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
] as const satisfies readonly (keyof RoleTemplateRow)[];

const grantAttributes = [
  "id",
  "role_template_id",
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
] as const satisfies readonly (keyof RoleTemplateModuleAccessRow)[];

export type RoleTemplateUpdateValues = Partial<Pick<RoleTemplateRow, "name" | "description" | "is_active" | "for_new_organizations" | "updated_by">>;

/** A template grant with the module it is for (code and name). */
export type RoleTemplateGrantRow = RoleTemplateModuleAccessRow & { module: Pick<ModuleRow, "code" | "module_name" | "sno"> };

const byName: Array<[string, string]> = [
  ["name", "ASC"],
  ["code", "ASC"],
];

async function list(filters: { activeOnly?: boolean; forNewOrganizations?: boolean } = {}, options: RepoOptions = {}): Promise<RoleTemplateRow[]> {
  const rows = await RoleTemplate.findAll({
    where: {
      ...(filters.activeOnly ? { is_active: true } : {}),
      ...(filters.forNewOrganizations ? { for_new_organizations: true } : {}),
    },
    attributes: [...attributes],
    order: byName,
    ...txOptions(options),
  });
  return toPlainList<RoleTemplateRow>(rows);
}

async function findById(templateId: string, options: RepoOptions = {}): Promise<RoleTemplateRow | null> {
  const row = await RoleTemplate.findOne({ where: { id: templateId }, attributes: [...attributes], ...txOptions(options), ...lockOptions(options) });
  return toPlain<RoleTemplateRow>(row);
}

async function listByIds(templateIds: readonly string[], options: RepoOptions = {}): Promise<RoleTemplateRow[]> {
  if (templateIds.length === 0) return [];
  const rows = await RoleTemplate.findAll({ where: { id: { [Op.in]: [...templateIds] } }, attributes: [...attributes], ...txOptions(options) });
  return toPlainList<RoleTemplateRow>(rows);
}

async function findByCode(code: string, options: RepoOptions = {}): Promise<RoleTemplateRow | null> {
  const row = await RoleTemplate.findOne({ where: { code }, attributes: [...attributes], ...txOptions(options) });
  return toPlain<RoleTemplateRow>(row);
}

async function create(values: CreationAttributes<RoleTemplate>, options: WriteOptions = {}): Promise<RoleTemplateRow> {
  const row = await RoleTemplate.create(values, txOptions(options));
  return row.get({ plain: true });
}

async function updateById(templateId: string, values: RoleTemplateUpdateValues, options: WriteOptions = {}): Promise<RoleTemplateRow | null> {
  await RoleTemplate.update(values, { where: { id: templateId }, ...txOptions(options) });
  return findById(templateId, options);
}

async function findGrants(templateIds: readonly string[], activeModulesOnly: boolean, options: RepoOptions): Promise<RoleTemplateGrantRow[]> {
  if (templateIds.length === 0) return [];
  const rows = await RoleTemplateModuleAccess.findAll({
    where: { role_template_id: { [Op.in]: [...templateIds] } },
    attributes: [...grantAttributes],
    include: [
      { model: AppModule, as: "module", required: true, ...(activeModulesOnly ? { where: { is_active: true } } : {}), attributes: ["code", "module_name", "sno"] },
    ],
    order: [[{ model: AppModule, as: "module" }, "sno", "ASC"]],
    ...txOptions(options),
  });
  return toPlainList<RoleTemplateGrantRow>(rows);
}

/** The templates' grants on switched-on modules (what the screens show and what a new role copies, Phase 2e). */
async function listGrantsWithModules(templateIds: readonly string[], options: RepoOptions = {}): Promise<RoleTemplateGrantRow[]> {
  return findGrants(templateIds, true, options);
}

/**
 * Every grant of the templates, switched-off modules included: what a new organization's roles start with, so a
 * module switched off today still works for them when it is switched back on (Phase 2e).
 */
async function listAllGrantsWithModules(templateIds: readonly string[], options: RepoOptions = {}): Promise<RoleTemplateGrantRow[]> {
  return findGrants(templateIds, false, options);
}

/**
 * Replaces a template's grant set: delete, then insert, in the caller's transaction. Grants on switched-off modules
 * stay (Phase 2e), as for roles.
 */
async function replaceGrants(
  templateId: string,
  values: CreationAttributes<RoleTemplateModuleAccess>[],
  options: { transaction: Transaction },
): Promise<void> {
  await RoleTemplateModuleAccess.destroy({
    where: { role_template_id: templateId, module_id: { [Op.in]: activeModuleIds() } },
    transaction: options.transaction,
  });
  if (values.length > 0) await RoleTemplateModuleAccess.bulkCreate(values, { transaction: options.transaction });
}

/** How many templates grant this module (a module can't stop being a permission module while any do, Phase 2e). */
async function countGrantsByModule(moduleId: string, options: RepoOptions = {}): Promise<number> {
  return RoleTemplateModuleAccess.count({ where: { module_id: moduleId }, ...txOptions(options) });
}

export const roleTemplateRepository = {
  list,
  listByIds,
  findById,
  findByCode,
  create,
  updateById,
  listGrantsWithModules,
  listAllGrantsWithModules,
  replaceGrants,
  countGrantsByModule,
};
