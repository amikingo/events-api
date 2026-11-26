import type { Transaction } from "sequelize";
import { ConflictError, RoleInUseError, RoleLockedError } from "../errors/app-errors.js";
import { toRoleDto, type RoleDto } from "../mappers/staff.mapper.js";
import type { RoleRow } from "../models/role.js";
import { roleModuleAccessRepository } from "../repositories/role-module-access.repository.js";
import { roleRepository } from "../repositories/role.repository.js";
import { userRoleRepository } from "../repositories/user-role.repository.js";
import { ACTION_TO_FIELD, GRANTABLE_ACTIONS, SUPER_ADMIN_ROLE_CODE, type GrantableAction } from "../utils/rbac.js";
import type { RoleGrantInput } from "../validators/role.js";
import type { PlatformRoleCreateInput, PlatformRoleUpdateInput } from "../validators/platform.js";
import { grantRules, type GrantEditor } from "./grant-rules.js";
import { ensureFound, runTransaction } from "./helpers.js";

/**
 * Platform roles (Phase 2e, decided 26 November 2026): roles with no organization, for platform staff such as a
 * "Platform support" team. Managed at platform scope only (the Super Admin, or platform staff given Roles there).
 * Rules:
 * - any active permission module, platform modules included, and all 7 actions;
 * - nobody grants what they don't hold at platform scope (the Super Admin holds everything);
 * - SUPER_ADMIN is locked; codes are fixed and unique among platform roles; names unique (ignoring case);
 * - a platform role still held by active platform staff can't be switched off.
 * A platform role's grants on tenant modules apply in every organization (the permission engine already does this).
 * Tenant routes never see these roles: every tenant query is keyed by organization_id.
 */
const grantedActions = (grant: RoleGrantInput): GrantableAction[] => GRANTABLE_ACTIONS.filter((action) => grant[action] === true);

async function dtosOf(roles: RoleRow[], transaction?: Transaction): Promise<RoleDto[]> {
  const options = { transaction: transaction ?? null };
  const ids = roles.map((role) => role.id);
  const grants = await roleModuleAccessRepository.listWithModulesByRoleIds(ids, options);
  const members = await userRoleRepository.countActivePlatformByRoles(ids, options);
  return roles.map((role) => toRoleDto(role, grants, members.get(role.id) ?? 0));
}

async function oneDto(roleId: string, transaction?: Transaction): Promise<RoleDto> {
  const role = ensureFound(await roleRepository.findPlatformById(roleId, { transaction: transaction ?? null }), "Role not found");
  const [dto] = await dtosOf([role], transaction);
  return dto as RoleDto;
}

async function listRoles(): Promise<RoleDto[]> {
  return dtosOf(await roleRepository.listPlatform());
}

async function getRole(roleId: string): Promise<RoleDto> {
  return oneDto(roleId);
}

function assertUnlocked(role: RoleRow): void {
  if (role.code === SUPER_ADMIN_ROLE_CODE) throw new RoleLockedError("The Super Admin role can't be changed");
}

async function assertNameFree(name: string, transaction: Transaction, roleId?: string): Promise<void> {
  const roles = await roleRepository.listPlatform({ transaction });
  if (roles.some((role) => role.id !== roleId && role.name.trim().toLowerCase() === name.trim().toLowerCase())) {
    throw new ConflictError("Another platform role already has this name", { field: "name" });
  }
}

async function currentGrants(roleId: string, transaction: Transaction): Promise<Map<string, Set<GrantableAction>>> {
  const rows = await roleModuleAccessRepository.listWithModulesByRoleIds([roleId], { transaction });
  return new Map(rows.map((row) => [row.module.code, new Set(GRANTABLE_ACTIONS.filter((action) => row[ACTION_TO_FIELD[action]]))] as const));
}

/** Checks the grants (platform rules, then escalation for newly added actions) and returns the rows to store. */
async function checkedRows(roleId: string, grants: RoleGrantInput[], current: Map<string, Set<GrantableAction>>, editor: GrantEditor, transaction: Transaction) {
  const moduleIds = await grantRules.assertPlatformGrantable(
    grants.map((grant) => ({ module_code: grant.module_code, actions: grantedActions(grant) })),
    "body.grants",
    transaction,
  );
  await grantRules.assertHeld(
    null,
    editor,
    grants.map((grant) => ({ module_code: grant.module_code, actions: grantedActions(grant).filter((action) => !current.get(grant.module_code)?.has(action)) })),
  );
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
      created_by: editor.userId,
      updated_by: editor.userId,
    }));
}

async function createRole(input: PlatformRoleCreateInput, editor: GrantEditor): Promise<RoleDto> {
  return runTransaction(async (transaction) => {
    if (await roleRepository.findPlatformRoleByCode(input.code, { transaction })) {
      throw new ConflictError("Another platform role already uses this code", { field: "code" });
    }
    await assertNameFree(input.name, transaction);
    // Checked before anything is written, so an impossible or escalating grant leaves no role behind.
    const rows = await checkedRows("", input.grants, new Map(), editor, transaction);
    const role = await roleRepository.create(
      {
        organization_id: null,
        code: input.code,
        name: input.name,
        description: input.description ?? null,
        is_active: true,
        created_by: editor.userId,
        updated_by: editor.userId,
      },
      { transaction },
    );
    await roleModuleAccessRepository.replaceForRole(
      role.id,
      rows.map((row) => ({ ...row, role_id: role.id })),
      { transaction },
    );
    return oneDto(role.id, transaction);
  });
}

async function updateRole(roleId: string, input: PlatformRoleUpdateInput, editor: GrantEditor): Promise<RoleDto> {
  return runTransaction(async (transaction) => {
    const role = ensureFound(await roleRepository.findPlatformById(roleId, { transaction, lock: true }), "Role not found");
    assertUnlocked(role);
    if (input.name !== undefined) await assertNameFree(input.name, transaction, role.id);
    if (input.grants !== undefined) {
      const rows = await checkedRows(role.id, input.grants, await currentGrants(role.id, transaction), editor, transaction);
      await roleModuleAccessRepository.replaceForRole(role.id, rows, { transaction });
    }
    await roleRepository.updatePlatformById(
      role.id,
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
        updated_by: editor.userId,
      },
      { transaction },
    );
    return oneDto(role.id, transaction);
  });
}

/** Switch a platform role off (refused while platform staff hold it) or on. The current state again changes nothing. */
async function changeRoleStatus(roleId: string, isActive: boolean, editor: GrantEditor): Promise<RoleDto> {
  return runTransaction(async (transaction) => {
    const role = ensureFound(await roleRepository.findPlatformById(roleId, { transaction, lock: true }), "Role not found");
    assertUnlocked(role);
    if (role.is_active !== isActive) {
      if (!isActive) {
        const holders = await userRoleRepository.countActivePlatformByRole(role.id, { transaction });
        if (holders > 0) throw new RoleInUseError(undefined, { active_assignments: holders });
      }
      await roleRepository.updatePlatformById(role.id, { is_active: isActive, updated_by: editor.userId }, { transaction });
    }
    return oneDto(role.id, transaction);
  });
}

export const platformRoleService = { listRoles, getRole, createRole, updateRole, changeRoleStatus };
