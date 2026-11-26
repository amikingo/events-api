import type { Transaction } from "sequelize";
import { ConflictError, RoleInUseError, RoleLockedError } from "../errors/app-errors.js";
import { toRoleDto, type RoleDto } from "../mappers/staff.mapper.js";
import type { RoleRow } from "../models/role.js";
import { moduleRepository } from "../repositories/module.repository.js";
import { organizationRepository } from "../repositories/organization.repository.js";
import { roleModuleAccessRepository } from "../repositories/role-module-access.repository.js";
import { roleRepository } from "../repositories/role.repository.js";
import { userRoleRepository } from "../repositories/user-role.repository.js";
import { OWNER_ROLE_CODE } from "../utils/default-roles.js";
import { ACTION_TO_FIELD, GRANTABLE_ACTIONS, TENANT_GRANTABLE, type GrantableAction } from "../utils/rbac.js";
import type { RoleCreateInput, RoleGrantInput, RoleUpdateInput } from "../validators/role.js";
import { grantRules, type GrantEntry } from "./grant-rules.js";
import { ensureFound, runTransaction } from "./helpers.js";

/**
 * The organization's roles (Phase 2b read, Phase 2c write). Rules (decided 25 November 2026):
 * - a tenant role gets only what TENANT_GRANTABLE allows (never platform modules, never ORGANIZATIONS create);
 * - nobody gives a role an action they don't hold themselves in their signed-in assignment (Super Admin holds all);
 * - the built-in OWNER is locked; VIEWER and custom roles are editable; codes are fixed after creation;
 * - a role still held by active staff can't be switched off.
 * Changes apply on the next request: the permission engine reads grants from the database every time.
 */
export type RoleEditor = { userId: string; assignmentId: string };

async function listRoles(organizationId: string): Promise<RoleDto[]> {
  const roles = await roleRepository.listByOrganization(organizationId);
  const ids = roles.map((role) => role.id);
  const grants = await roleModuleAccessRepository.listWithModulesByRoleIds(ids);
  const members = await userRoleRepository.countActiveByRoles(organizationId, ids);
  return roles.map((role) => toRoleDto(role, grants, members.get(role.id) ?? 0));
}

async function getRole(organizationId: string, roleId: string): Promise<RoleDto> {
  const role = ensureFound(await roleRepository.findByOrganizationAndId(organizationId, roleId), "Role not found");
  const members = await userRoleRepository.countActiveByRoles(organizationId, [role.id]);
  return toRoleDto(role, await roleModuleAccessRepository.listWithModulesByRoleIds([role.id]), members.get(role.id) ?? 0);
}

const grantedActions = (grant: RoleGrantInput): GrantableAction[] => GRANTABLE_ACTIONS.filter((action) => grant[action] === true);

/** The boxes a client may leave out (Phase 2e): on update, a left-out box keeps the role's current value for that module. */
const OPTIONAL_ACTIONS = ["delete", "import", "export", "notify"] as const;

function keepLeftOut(grants: RoleGrantInput[], current: Map<string, Set<GrantableAction>>): RoleGrantInput[] {
  return grants.map((grant) => {
    const kept = { ...grant };
    for (const action of OPTIONAL_ACTIONS) {
      if (kept[action] === undefined) kept[action] = current.get(grant.module_code)?.has(action) ?? false;
    }
    return kept;
  });
}

/** A grant as the shared rules see it: the module and the actions it turns on. */
const toEntry = (grant: RoleGrantInput): GrantEntry => ({ module_code: grant.module_code, actions: grantedActions(grant) });

/**
 * Refuses anything a tenant role may not hold (400, naming the module or action) and returns the module ids.
 * Runs before the escalation check, so an impossible grant is always a 400, never a 403.
 */
async function assertGrantable(grants: RoleGrantInput[], transaction: Transaction): Promise<Map<string, string>> {
  return grantRules.assertGrantable(grants.map(toEntry), "body.grants", transaction);
}

/** The rows for a role's grants: all 7 actions (Phase 2e); a left-out box is stored as false. */
function grantRows(roleId: string, grants: RoleGrantInput[], moduleIds: Map<string, string>, actorId: string | null) {
  return grants
    .filter((grant) => grantedActions(grant).length > 0)
    .map((grant) => ({
      role_id: roleId,
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

/** Nobody hands out access they don't have: every newly granted action must be one the editor holds here. */
async function assertNoEscalation(organizationId: string, editor: RoleEditor, grants: RoleGrantInput[], current: Map<string, Set<GrantableAction>>) {
  const added = grants.map((grant) => ({
    module_code: grant.module_code,
    actions: grantedActions(grant).filter((action) => !current.get(grant.module_code)?.has(action)), // kept: not a new grant
  }));
  await grantRules.assertHeld(organizationId, editor, added);
}

async function currentGrants(roleId: string, transaction: Transaction): Promise<Map<string, Set<GrantableAction>>> {
  const rows = await roleModuleAccessRepository.listWithModulesByRoleIds([roleId], { transaction });
  return new Map(
    rows.map((row) => [row.module.code, new Set(GRANTABLE_ACTIONS.filter((action) => row[ACTION_TO_FIELD[action]]))] as const),
  );
}

async function assertNameFree(organizationId: string, name: string, transaction: Transaction, roleId?: string): Promise<void> {
  const roles = await roleRepository.listByOrganization(organizationId, { transaction });
  if (roles.some((role) => role.id !== roleId && role.name.trim().toLowerCase() === name.trim().toLowerCase())) {
    throw new ConflictError("Another role already has this name", { field: "name" });
  }
}

function assertUnlocked(role: RoleRow): void {
  if (role.code === OWNER_ROLE_CODE) throw new RoleLockedError();
}

async function roleDto(organizationId: string, roleId: string, transaction: Transaction): Promise<RoleDto> {
  const role = ensureFound(await roleRepository.findByOrganizationAndId(organizationId, roleId, { transaction }), "Role not found");
  const members = await userRoleRepository.countActiveByRoles(organizationId, [role.id], { transaction });
  return toRoleDto(role, await roleModuleAccessRepository.listWithModulesByRoleIds([role.id], { transaction }), members.get(role.id) ?? 0);
}

async function createRole(organizationId: string, input: RoleCreateInput, editor: RoleEditor): Promise<RoleDto> {
  return runTransaction(async (transaction) => {
    ensureFound(await organizationRepository.findById(organizationId, { transaction }), "Organization not found");
    if (await roleRepository.findByOrganizationAndCode(organizationId, input.code, { transaction })) {
      throw new ConflictError("Another role already uses this code", { field: "code" });
    }
    await assertNameFree(organizationId, input.name, transaction);
    const moduleIds = await assertGrantable(input.grants, transaction);
    await assertNoEscalation(organizationId, editor, input.grants, new Map());

    const role = await roleRepository.create(
      {
        organization_id: organizationId,
        code: input.code,
        name: input.name,
        description: input.description ?? null,
        is_active: true,
        created_by: editor.userId,
        updated_by: editor.userId,
      },
      { transaction },
    );
    await roleModuleAccessRepository.replaceForRole(role.id, grantRows(role.id, input.grants, moduleIds, editor.userId), { transaction });
    return roleDto(organizationId, role.id, transaction);
  });
}

async function updateRole(organizationId: string, roleId: string, input: RoleUpdateInput, editor: RoleEditor): Promise<RoleDto> {
  return runTransaction(async (transaction) => {
    const role = ensureFound(await roleRepository.findByOrganizationAndId(organizationId, roleId, { transaction, lock: true }), "Role not found");
    assertUnlocked(role);
    if (input.name !== undefined) await assertNameFree(organizationId, input.name, transaction, role.id);
    if (input.grants !== undefined) {
      const current = await currentGrants(role.id, transaction);
      const grants = keepLeftOut(input.grants, current);
      const moduleIds = await assertGrantable(grants, transaction);
      await assertNoEscalation(organizationId, editor, grants, current);
      await roleModuleAccessRepository.replaceForRole(role.id, grantRows(role.id, grants, moduleIds, editor.userId), { transaction });
    }
    await roleRepository.updateByOrganizationAndId(
      organizationId,
      role.id,
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
        updated_by: editor.userId,
      },
      { transaction },
    );
    return roleDto(organizationId, role.id, transaction);
  });
}

/** Switch a role off (refused while staff hold it) or back on. Asking for the current state changes nothing. */
async function changeRoleStatus(organizationId: string, roleId: string, isActive: boolean, editor: RoleEditor): Promise<RoleDto> {
  return runTransaction(async (transaction) => {
    const role = ensureFound(await roleRepository.findByOrganizationAndId(organizationId, roleId, { transaction, lock: true }), "Role not found");
    assertUnlocked(role);
    if (role.is_active !== isActive) {
      if (!isActive) {
        const holders = await userRoleRepository.countActiveByRole(organizationId, role.id, { transaction });
        if (holders > 0) throw new RoleInUseError(undefined, { active_assignments: holders });
      }
      await roleRepository.updateByOrganizationAndId(organizationId, role.id, { is_active: isActive, updated_by: editor.userId }, { transaction });
    }
    return roleDto(organizationId, role.id, transaction);
  });
}

/** A module an organization's roles, templates and overrides may grant, with the actions it offers (Phase 2e). */
export type GrantableModuleDto = { module_code: string; module_name: string; sno: number; actions: GrantableAction[] };

/**
 * The modules the role, template and override grids show, built from the active modules and TENANT_GRANTABLE, so the
 * screens follow the API: a new tenant module needs no website change.
 */
async function listGrantableModules(organizationId: string): Promise<GrantableModuleDto[]> {
  ensureFound(await organizationRepository.findById(organizationId), "Organization not found");
  return (await moduleRepository.listActiveOrdered())
    .filter((module) => module.is_permission && TENANT_GRANTABLE[module.code])
    .map((module) => ({ module_code: module.code, module_name: module.module_name, sno: module.sno, actions: [...(TENANT_GRANTABLE[module.code] ?? [])] }));
}

export const roleService = { listRoles, getRole, createRole, updateRole, changeRoleStatus, listGrantableModules };
