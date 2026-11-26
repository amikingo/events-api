import type { Transaction } from "sequelize";
import { ConflictError, RoleLockedError } from "../errors/app-errors.js";
import { toRoleTemplateDto, type RoleTemplateDto } from "../mappers/role-template.mapper.js";
import type { RoleTemplateRow } from "../models/role-template.js";
import { organizationRepository } from "../repositories/organization.repository.js";
import { roleRepository } from "../repositories/role.repository.js";
import { roleTemplateRepository, type RoleTemplateGrantRow } from "../repositories/role-template.repository.js";
import { DEFAULT_TENANT_ROLES, OWNER_ROLE_CODE, type DefaultRoleTemplate } from "../utils/default-roles.js";
import { ACTION_TO_FIELD, GRANTABLE_ACTIONS, PERMISSION_ACTIONS, type GrantableAction, type PermissionAction } from "../utils/rbac.js";
import type { RoleGrantInput } from "../validators/role.js";
import type { RoleTemplateCreateInput, RoleTemplateUpdateInput } from "../validators/role-template.js";
import { grantRules } from "./grant-rules.js";
import { ensureFound, runTransaction } from "./helpers.js";

/**
 * Role templates (Phase 2d, decided 25 November 2026): a platform library the Super Admin edits (platform scope,
 * ROLE_TEMPLATES). Rules:
 * - grants follow TENANT_GRANTABLE (a role made from a template lives in an organization);
 * - the OWNER template is locked like the Owner role: no edits, never switched off, always for new organizations;
 * - new organizations get roles copied from the active templates marked for new organizations; if the OWNER
 *   template is missing, they fall back to DEFAULT_TENANT_ROLES, so an organization always gets its Owner;
 * - copies, never links: editing a template never changes an existing organization's roles;
 * - Owners see the active templates (Roles › create) to start a role from one; the role is then made with the normal
 *   POST /roles, so the escalation rule still applies there.
 */
const grantedActions = (grant: RoleGrantInput): GrantableAction[] => GRANTABLE_ACTIONS.filter((action) => grant[action] === true);

async function dtoOf(templates: RoleTemplateRow[], transaction?: Transaction): Promise<RoleTemplateDto[]> {
  const grants = await roleTemplateRepository.listGrantsWithModules(
    templates.map((template) => template.id),
    { transaction: transaction ?? null },
  );
  return templates.map((template) => toRoleTemplateDto(template, grants, OWNER_ROLE_CODE));
}

async function oneDto(templateId: string, transaction?: Transaction): Promise<RoleTemplateDto> {
  const template = ensureFound(await roleTemplateRepository.findById(templateId, { transaction: transaction ?? null }), "Role template not found");
  const [dto] = await dtoOf([template], transaction);
  return dto as RoleTemplateDto;
}

/** Every template, switched off ones included (the Super Admin's screen). */
async function listTemplates(): Promise<RoleTemplateDto[]> {
  return dtoOf(await roleTemplateRepository.list());
}

/** The active templates an Owner may start a role from. */
async function listForOrganization(organizationId: string): Promise<RoleTemplateDto[]> {
  ensureFound(await organizationRepository.findById(organizationId), "Organization not found");
  return dtoOf(await roleTemplateRepository.list({ activeOnly: true }));
}

async function getTemplate(templateId: string): Promise<RoleTemplateDto> {
  return oneDto(templateId);
}

async function assertNameFree(name: string, transaction: Transaction, templateId?: string): Promise<void> {
  const templates = await roleTemplateRepository.list({}, { transaction });
  if (templates.some((template) => template.id !== templateId && template.name.trim().toLowerCase() === name.trim().toLowerCase())) {
    throw new ConflictError("Another template already has this name", { field: "name" });
  }
}

/** Refuses anything a tenant may not hold (400, naming the module or action) and returns the module ids. */
async function checkGrants(grants: RoleGrantInput[], transaction: Transaction): Promise<Map<string, string>> {
  return grantRules.assertGrantable(
    grants.map((grant) => ({ module_code: grant.module_code, actions: grantedActions(grant) })),
    "body.grants",
    transaction,
  );
}

/** The grant rows: all 7 actions (Phase 2e); a left-out box means no. */
function grantRows(templateId: string, grants: RoleGrantInput[], moduleIds: Map<string, string>, actorId: string | null) {
  return grants
    .filter((grant) => grantedActions(grant).length > 0)
    .map((grant) => ({
      role_template_id: templateId,
      module_id: moduleIds.get(grant.module_code) as string,
      can_view: grant.view,
      can_create: grant.create,
      can_update: grant.update,
      can_delete: grant.delete === true,
      can_import: grant.import === true,
      can_export: grant.export === true,
      can_notify: grant.notify === true,
      created_by: actorId,
      updated_by: actorId,
    }));
}

async function createTemplate(input: RoleTemplateCreateInput, actorId: string | null): Promise<RoleTemplateDto> {
  return runTransaction(async (transaction) => {
    if (await roleTemplateRepository.findByCode(input.code, { transaction })) {
      throw new ConflictError("Another template already uses this code", { field: "code" });
    }
    await assertNameFree(input.name, transaction);
    // Checked before anything is written, so an impossible grant leaves no template behind.
    const moduleIds = await checkGrants(input.grants, transaction);
    const template = await roleTemplateRepository.create(
      {
        code: input.code,
        name: input.name,
        description: input.description ?? null,
        is_active: true,
        for_new_organizations: input.for_new_organizations ?? false,
        created_by: actorId,
        updated_by: actorId,
      },
      { transaction },
    );
    await roleTemplateRepository.replaceGrants(template.id, grantRows(template.id, input.grants, moduleIds, actorId), { transaction });
    return oneDto(template.id, transaction);
  });
}

function assertUnlocked(template: RoleTemplateRow): void {
  if (template.code === OWNER_ROLE_CODE) throw new RoleLockedError("The Owner template can't be changed");
}

async function updateTemplate(templateId: string, input: RoleTemplateUpdateInput, actorId: string | null): Promise<RoleTemplateDto> {
  return runTransaction(async (transaction) => {
    const template = ensureFound(await roleTemplateRepository.findById(templateId, { transaction, lock: true }), "Role template not found");
    assertUnlocked(template);
    if (input.name !== undefined) await assertNameFree(input.name, transaction, template.id);
    if (input.grants !== undefined) {
      const moduleIds = await checkGrants(input.grants, transaction);
      await roleTemplateRepository.replaceGrants(template.id, grantRows(template.id, input.grants, moduleIds, actorId), { transaction });
    }
    await roleTemplateRepository.updateById(
      template.id,
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.for_new_organizations === undefined ? {} : { for_new_organizations: input.for_new_organizations }),
        updated_by: actorId,
      },
      { transaction },
    );
    return oneDto(template.id, transaction);
  });
}

/** Switch a template off or on. The OWNER template is never switched off. Asking for the current state changes nothing. */
async function changeTemplateStatus(templateId: string, isActive: boolean, actorId: string | null): Promise<RoleTemplateDto> {
  return runTransaction(async (transaction) => {
    const template = ensureFound(await roleTemplateRepository.findById(templateId, { transaction, lock: true }), "Role template not found");
    assertUnlocked(template);
    if (template.is_active !== isActive) {
      await roleTemplateRepository.updateById(template.id, { is_active: isActive, updated_by: actorId }, { transaction });
    }
    return oneDto(template.id, transaction);
  });
}

function actionsOf(grant: RoleTemplateGrantRow): PermissionAction[] {
  return PERMISSION_ACTIONS.filter((action) => grant[ACTION_TO_FIELD[action]]);
}

/**
 * The roles a new organization starts with: the active templates marked for new organizations, as role templates the
 * provisioning code copies. Falls back to DEFAULT_TENANT_ROLES when there is no such OWNER template, so a new
 * organization always gets its Owner.
 */
async function templatesForNewOrganization(transaction: Transaction): Promise<readonly DefaultRoleTemplate[]> {
  const templates = await roleTemplateRepository.list({ activeOnly: true, forNewOrganizations: true }, { transaction });
  if (!templates.some((template) => template.code === OWNER_ROLE_CODE)) return DEFAULT_TENANT_ROLES;
  const grants = await roleTemplateRepository.listGrantsWithModules(
    templates.map((template) => template.id),
    { transaction },
  );
  return templates.map((template) => ({
    templateId: template.id,
    code: template.code,
    name: template.name,
    description: template.description ?? "",
    grants: grants
      .filter((grant) => grant.role_template_id === template.id)
      .map((grant) => ({ moduleCode: grant.module.code as DefaultRoleTemplate["grants"][number]["moduleCode"], actions: actionsOf(grant) })),
  }));
}

/** A role made from a template, in any organization (Phase 2e). */
export type TemplateRoleDto = { id: string; code: string; name: string; is_active: boolean; organization: { id: string; name: string; slug: string } };

/** The Super Admin's "roles using this template": every organization's roles made from it. Still copies, not links. */
async function listTemplateRoles(templateId: string): Promise<TemplateRoleDto[]> {
  ensureFound(await roleTemplateRepository.findById(templateId), "Role template not found");
  return (await roleRepository.listByTemplate(templateId)).map((role) => ({
    id: role.id,
    code: role.code,
    name: role.name,
    is_active: role.is_active,
    organization: { id: role.organization.id, name: role.organization.name, slug: role.organization.slug },
  }));
}

export const roleTemplateService = {
  listTemplateRoles,
  listTemplates,
  listForOrganization,
  getTemplate,
  createTemplate,
  updateTemplate,
  changeTemplateStatus,
  templatesForNewOrganization,
};
