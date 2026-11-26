import type { Transaction } from "sequelize";
import { centralAuthClient, type CentralUser } from "../clients/central-auth.client.js";
import {
  AssignmentScopeConflictError,
  BranchInactiveError,
  CentralAccountNotFoundError,
  InvalidBranchStateError,
  LastOwnerAssignmentError,
  OrganizationInactiveError,
  OwnAssignmentError,
  OwnerNotOverridableError,
  RoleInactiveError,
} from "../errors/app-errors.js";
import { toStaffAssignmentDto, toStaffProfileDto, type StaffAssignmentDto, type StaffProfileDto } from "../mappers/staff.mapper.js";
import type { RoleRow } from "../models/role.js";
import { branchRepository } from "../repositories/branch.repository.js";
import { moduleRepository } from "../repositories/module.repository.js";
import { organizationRepository } from "../repositories/organization.repository.js";
import { roleModuleAccessRepository } from "../repositories/role-module-access.repository.js";
import { roleRepository } from "../repositories/role.repository.js";
import { userModuleAccessRepository } from "../repositories/user-module-access.repository.js";
import { userRoleRepository, type StaffAssignmentRow } from "../repositories/user-role.repository.js";
import { OWNER_ROLE_CODE } from "../utils/default-roles.js";
import { logger } from "../utils/logger.js";
import { buildPagination } from "../utils/pagination.js";
import { ACTION_TO_FIELD, GRANTABLE_ACTIONS, TENANT_GRANTABLE, type GrantableAction } from "../utils/rbac.js";
import type {
  StaffAssignmentCreateInput,
  StaffAssignmentListQuery,
  StaffAssignmentUpdateInput,
  StaffOverrideInput,
  StaffOverridesReplaceInput,
} from "../validators/staff-assignment.js";
import { grantRules, type GrantEditor } from "./grant-rules.js";
import { ensureFound, runTransaction } from "./helpers.js";
import { staffRules } from "./staff-rules.js";

/**
 * Staff management in the app (Phase 2b), the same rules as the assign:staff script. A person is found in
 * auth-cheche by mobile (look up only: this API never creates accounts or handles passwords). Every write runs in
 * one transaction; the auth-cheche call always happens before it, so no lock is held while waiting on the network.
 */
export type StaffLookupDto = { user_id: string } & NonNullable<StaffProfileDto>;
export type AssignOutcome = "CREATED" | "REACTIVATED" | "UNCHANGED";

async function findAccount(mobile: string): Promise<CentralUser> {
  const user = await centralAuthClient.findUserByMobile(mobile);
  if (!user) throw new CentralAccountNotFoundError(undefined, { mobile });
  return user;
}

/** Names for a page of assignments, one auth-cheche call. Best effort: if it fails, profiles are null. */
async function profilesOf(userIds: string[]): Promise<Map<string, CentralUser>> {
  const unique = [...new Set(userIds)];
  try {
    return new Map((await centralAuthClient.getUsersByIds(unique)).map((user) => [user.userId, user]));
  } catch (error) {
    logger.warn({ err: error instanceof Error ? error.message : error, count: unique.length }, "Staff names could not be read from Central Auth");
    return new Map();
  }
}

async function activeTenantRole(organizationId: string, roleId: string, transaction: Transaction): Promise<RoleRow> {
  // Platform roles (organization_id NULL) are never found here, so they can't be handed out.
  // Locked, so a role being switched off at the same moment can't end up with a new active assignment.
  const role = ensureFound(await roleRepository.findByOrganizationAndId(organizationId, roleId, { transaction, lock: true }), "Role not found");
  if (!role.is_active) throw new RoleInactiveError();
  return role;
}

async function activeBranch(organizationId: string, hasBranches: boolean, branchId: string, transaction: Transaction): Promise<string> {
  if (!hasBranches) throw new InvalidBranchStateError("This organization has no branches. Add a branch first; that turns branches on.");
  const branch = ensureFound(await branchRepository.findByOrganizationAndId(organizationId, branchId, { transaction }), "Branch not found");
  if (!branch.is_active) throw new BranchInactiveError();
  return branch.id;
}

/** Refuses a change that would leave the organization without an active Owner. Call under lockOwnersOfOrganization. */
async function keepAnOwner(organizationId: string, transaction: Transaction): Promise<void> {
  if ((await userRoleRepository.countActiveOwners(organizationId, { transaction })) <= 1) throw new LastOwnerAssignmentError();
}

async function staffDto(organizationId: string, assignmentId: string, user?: CentralUser, transaction?: Transaction): Promise<StaffAssignmentDto> {
  const row: StaffAssignmentRow = ensureFound(
    await userRoleRepository.findStaffByOrganizationAndId(organizationId, assignmentId, { transaction: transaction ?? null }),
    "Staff assignment not found",
  );
  return toStaffAssignmentDto(row, user);
}

/** Who uses this mobile in auth-cheche, so the owner can confirm the person before assigning. */
async function lookUp(mobile: string): Promise<StaffLookupDto> {
  const user = await findAccount(mobile);
  return { user_id: user.userId, ...(toStaffProfileDto(user) as NonNullable<StaffProfileDto>) };
}

/**
 * One person can't hold the same role for the whole organization and for a branch at the same time (Phase 2e);
 * holding it on several branches is fine. Call under lockAssignmentsOfUser; `exceptId` is the assignment being changed.
 */
async function assertNoScopeOverlap(
  scope: { userId: string; organizationId: string; roleId: string; branchId: string | null; exceptId?: string },
  transaction: Transaction,
): Promise<void> {
  const others = (await userRoleRepository.listAllByUser(scope.userId, { transaction })).filter(
    (row) => row.is_active && row.id !== scope.exceptId && row.organization_id === scope.organizationId && row.role_id === scope.roleId,
  );
  const clash = scope.branchId === null ? others.some((row) => row.branch_id !== null) : others.some((row) => row.branch_id === null);
  if (clash) throw new AssignmentScopeConflictError(undefined, { role_id: scope.roleId });
}

async function list(organizationId: string, query: StaffAssignmentListQuery): Promise<{ rows: StaffAssignmentDto[]; count: number }> {
  const { limit, offset } = buildPagination(query);
  const { rows, count } = await userRoleRepository.listByOrganization(organizationId, {
    isActive: query.is_active,
    roleId: query.role_id,
    branchId: query.branch_id,
    limit,
    offset,
  });
  const profiles = await profilesOf(rows.map((row) => row.user_id));
  return { rows: rows.map((row) => toStaffAssignmentDto(row, profiles.get(row.user_id))), count };
}

/** One assignment with the person's name from auth-cheche (best effort: profile null when it can't be read). */
async function get(organizationId: string, assignmentId: string): Promise<StaffAssignmentDto> {
  const assignment = await staffDto(organizationId, assignmentId);
  return { ...assignment, profile: toStaffProfileDto((await profilesOf([assignment.user_id])).get(assignment.user_id)) };
}

/**
 * Gives the person behind this mobile a role of the organization, organization-wide or for one branch. An identical
 * active assignment is returned unchanged; an identical inactive one is reactivated.
 */
async function assign(
  organizationId: string,
  input: StaffAssignmentCreateInput,
  actorId: string | null,
): Promise<{ assignment: StaffAssignmentDto; outcome: AssignOutcome }> {
  const user = await findAccount(input.mobile);

  return runTransaction(async (transaction) => {
    await userRoleRepository.lockAssignmentsOfUser(user.userId, { transaction });
    const organization = ensureFound(await organizationRepository.findById(organizationId, { transaction }), "Organization not found");
    if (!organization.is_active) throw new OrganizationInactiveError();
    const role = await activeTenantRole(organization.id, input.role_id, transaction);
    const branchId = input.branch_id ? await activeBranch(organization.id, organization.has_branches, input.branch_id, transaction) : null;
    await staffRules.assertNotStaffElsewhere(user.userId, organization.id, transaction);

    const existing = await userRoleRepository.findByScope(
      { userId: user.userId, roleId: role.id, organizationId: organization.id, branchId },
      { transaction, lock: true },
    );
    if (!existing?.is_active) {
      await assertNoScopeOverlap({ userId: user.userId, organizationId: organization.id, roleId: role.id, branchId, exceptId: existing?.id }, transaction);
    }
    let assignmentId: string;
    let outcome: AssignOutcome;
    if (existing?.is_active) {
      assignmentId = existing.id;
      outcome = "UNCHANGED";
    } else if (existing) {
      await userRoleRepository.setActive(existing.id, true, actorId, { transaction });
      assignmentId = existing.id;
      outcome = "REACTIVATED";
    } else {
      const created = await userRoleRepository.create(
        { user_id: user.userId, role_id: role.id, organization_id: organization.id, branch_id: branchId, created_by: actorId, updated_by: actorId },
        { transaction },
      );
      assignmentId = created.id;
      outcome = "CREATED";
    }
    return { assignment: await staffDto(organization.id, assignmentId, user, transaction), outcome };
  });
}

/**
 * Another role or branch for the same person. The last active Owner keeps the Owner role. When the role changes,
 * `override_count` says how many permission overrides the person still has (they stay; Phase 2d), so the Owner can
 * review them.
 */
async function update(
  organizationId: string,
  assignmentId: string,
  input: StaffAssignmentUpdateInput,
  actorId: string | null,
): Promise<StaffAssignmentDto & { role_changed: boolean; override_count: number }> {
  let roleChanged = false;
  let overrideCount = 0;
  const assignment = await runTransaction(async (transaction) => {
    await userRoleRepository.lockOwnersOfOrganization(organizationId, { transaction });
    const current = ensureFound(
      await userRoleRepository.findByOrganizationAndId(organizationId, assignmentId, { transaction, lock: true }),
      "Staff assignment not found",
    );
    const organization = ensureFound(await organizationRepository.findById(organizationId, { transaction }), "Organization not found");
    const currentRole = ensureFound(await roleRepository.findByOrganizationAndId(organizationId, current.role_id, { transaction }), "Role not found");
    const nextRole = input.role_id === undefined ? currentRole : await activeTenantRole(organizationId, input.role_id, transaction);
    let branchId = current.branch_id;
    if (input.branch_id !== undefined) {
      branchId = input.branch_id === null ? null : await activeBranch(organizationId, organization.has_branches, input.branch_id, transaction);
    }

    if (current.is_active && currentRole.code === OWNER_ROLE_CODE && nextRole.code !== OWNER_ROLE_CODE) await keepAnOwner(organizationId, transaction);
    if (current.is_active) {
      await userRoleRepository.lockAssignmentsOfUser(current.user_id, { transaction });
      await assertNoScopeOverlap({ userId: current.user_id, organizationId, roleId: nextRole.id, branchId, exceptId: current.id }, transaction);
    }
    await userRoleRepository.updateRoleAndBranch(current.id, { role_id: nextRole.id, branch_id: branchId, updated_by: actorId }, { transaction });
    roleChanged = nextRole.id !== current.role_id;
    overrideCount = await userModuleAccessRepository.countActiveByUserRole(current.id, { transaction });
    return staffDto(organizationId, current.id, undefined, transaction);
  });
  return {
    ...assignment,
    profile: toStaffProfileDto((await profilesOf([assignment.user_id])).get(assignment.user_id)),
    role_changed: roleChanged,
    override_count: overrideCount,
  };
}

/** Activate or deactivate. The last active Owner can't be deactivated; asking for the current state changes nothing. */
async function changeStatus(organizationId: string, assignmentId: string, isActive: boolean, actorId: string | null): Promise<StaffAssignmentDto> {
  const assignment = await runTransaction(async (transaction) => {
    await userRoleRepository.lockOwnersOfOrganization(organizationId, { transaction });
    const current = ensureFound(
      await userRoleRepository.findByOrganizationAndId(organizationId, assignmentId, { transaction, lock: true }),
      "Staff assignment not found",
    );
    if (current.is_active !== isActive) {
      const role = ensureFound(await roleRepository.findByOrganizationAndId(organizationId, current.role_id, { transaction }), "Role not found");
      if (!isActive && role.code === OWNER_ROLE_CODE) await keepAnOwner(organizationId, transaction);
      if (isActive && !role.is_active) throw new RoleInactiveError();
      if (isActive) {
        await userRoleRepository.lockAssignmentsOfUser(current.user_id, { transaction });
        await assertNoScopeOverlap(
          { userId: current.user_id, organizationId, roleId: current.role_id, branchId: current.branch_id, exceptId: current.id },
          transaction,
        );
      }
      await userRoleRepository.setActive(current.id, isActive, actorId, { transaction });
    }
    return staffDto(organizationId, current.id, undefined, transaction);
  });
  return { ...assignment, profile: toStaffProfileDto((await profilesOf([assignment.user_id])).get(assignment.user_id)) };
}

/**
 * Deletes an assignment for good (Phase 2e, decided 26 November 2026): any assignment except the last active Owner,
 * and never your own. Its permission overrides go with it. Switching off stays the normal way.
 */
async function remove(organizationId: string, assignmentId: string, actorId: string | null): Promise<void> {
  await runTransaction(async (transaction) => {
    await userRoleRepository.lockOwnersOfOrganization(organizationId, { transaction });
    const current = ensureFound(
      await userRoleRepository.findByOrganizationAndId(organizationId, assignmentId, { transaction, lock: true }),
      "Staff assignment not found",
    );
    if (actorId !== null && current.user_id === actorId) throw new OwnAssignmentError("You can't delete your own assignment. Ask another Owner");
    const role = ensureFound(await roleRepository.findByOrganizationAndId(organizationId, current.role_id, { transaction }), "Role not found");
    if (current.is_active && role.code === OWNER_ROLE_CODE) await keepAnOwner(organizationId, transaction);
    await userRoleRepository.deleteByOrganizationAndId(organizationId, current.id, { transaction });
  });
}

// --- Permission overrides (Phase 2d) -----------------------------------------------------------------------
//
// One staff member gets more or less than their role, module by module: each box is true (allow), false (deny) or
// null (follow the role). Managed by people with Staff Assignments › update (Owners). Rules (decided 25 November
// 2026): only TENANT_GRANTABLE modules and actions; allowing needs the editor to hold the action (denying needs no
// check); never on an Owner's assignment; never on your own. Saving replaces the whole set. The permission engine
// already applies them, on the next request.

export type OverrideFlags = Record<GrantableAction, boolean | null>;
export type OverrideModuleDto = {
  module_code: string;
  module_name: string;
  /** The boxes this module offers (TENANT_GRANTABLE). */
  actions: GrantableAction[];
  /** What the role gives. */
  role: Record<GrantableAction, boolean>;
  /** The override: true, false or null (follow the role). */
  override: OverrideFlags;
  /** What the person can do: the override where set, otherwise the role. */
  effective: Record<GrantableAction, boolean>;
};
export type StaffOverridesDto = {
  assignment_id: string;
  role: { id: string; code: string; name: string };
  /** Owners have full access and can't get overrides. */
  overridable: boolean;
  modules: OverrideModuleDto[];
};

const mentioned = (override: StaffOverrideInput): GrantableAction[] => GRANTABLE_ACTIONS.filter((action) => override[action] !== undefined && override[action] !== null);
const allowed = (override: StaffOverrideInput): GrantableAction[] => GRANTABLE_ACTIONS.filter((action) => override[action] === true);

async function overridesDto(organizationId: string, assignmentId: string, transaction?: Transaction): Promise<StaffOverridesDto> {
  const options = { transaction: transaction ?? null };
  const assignment = ensureFound(await userRoleRepository.findByOrganizationAndId(organizationId, assignmentId, options), "Staff assignment not found");
  const role = ensureFound(await roleRepository.findByOrganizationAndId(organizationId, assignment.role_id, options), "Role not found");
  const modules = (await moduleRepository.listActiveOrdered(options)).filter((module) => module.is_permission && TENANT_GRANTABLE[module.code]);
  const grants = new Map((await roleModuleAccessRepository.listByRoleId(role.id, options)).map((grant) => [grant.module_id, grant]));
  const overrides = new Map((await userModuleAccessRepository.listActiveByUserRole(assignment.id, options)).map((row) => [row.module_id, row]));

  return {
    assignment_id: assignment.id,
    role: { id: role.id, code: role.code, name: role.name },
    overridable: role.code !== OWNER_ROLE_CODE,
    modules: modules.map((module) => {
      const grant = grants.get(module.id);
      const row = overrides.get(module.id);
      const roleFlags = Object.fromEntries(GRANTABLE_ACTIONS.map((action) => [action, grant?.[ACTION_TO_FIELD[action]] === true])) as Record<GrantableAction, boolean>;
      const overrideFlags = Object.fromEntries(GRANTABLE_ACTIONS.map((action) => [action, row?.[ACTION_TO_FIELD[action]] ?? null])) as OverrideFlags;
      const effective = Object.fromEntries(GRANTABLE_ACTIONS.map((action) => [action, overrideFlags[action] ?? roleFlags[action]])) as Record<GrantableAction, boolean>;
      return {
        module_code: module.code,
        module_name: module.module_name,
        actions: [...(TENANT_GRANTABLE[module.code] ?? [])],
        role: roleFlags,
        override: overrideFlags,
        effective,
      };
    }),
  };
}

async function listOverrides(organizationId: string, assignmentId: string): Promise<StaffOverridesDto> {
  return overridesDto(organizationId, assignmentId);
}

async function replaceOverrides(
  organizationId: string,
  assignmentId: string,
  input: StaffOverridesReplaceInput,
  editor: GrantEditor,
): Promise<StaffOverridesDto> {
  return runTransaction(async (transaction) => {
    const assignment = ensureFound(
      await userRoleRepository.findByOrganizationAndId(organizationId, assignmentId, { transaction, lock: true }),
      "Staff assignment not found",
    );
    const role = ensureFound(await roleRepository.findByOrganizationAndId(organizationId, assignment.role_id, { transaction }), "Role not found");
    if (role.code === OWNER_ROLE_CODE) throw new OwnerNotOverridableError();
    if (assignment.user_id === editor.userId) throw new OwnAssignmentError();

    const moduleIds = await grantRules.assertGrantable(
      input.overrides.map((override) => ({ module_code: override.module_code, actions: mentioned(override) })),
      "body.overrides",
      transaction,
    );
    // Only newly allowed actions need the editor to hold them; keeping an existing allow, or denying, needs nothing.
    const codeById = new Map([...moduleIds].map(([code, id]) => [id, code]));
    const currentAllows = new Map<string, Set<GrantableAction>>();
    for (const row of await userModuleAccessRepository.listActiveByUserRole(assignment.id, { transaction })) {
      const code = codeById.get(row.module_id);
      if (code) currentAllows.set(code, new Set(GRANTABLE_ACTIONS.filter((action) => row[ACTION_TO_FIELD[action]] === true)));
    }
    await grantRules.assertHeld(
      organizationId,
      editor,
      input.overrides.map((override) => ({
        module_code: override.module_code,
        actions: allowed(override).filter((action) => !currentAllows.get(override.module_code)?.has(action)),
      })),
    );

    const rows = input.overrides
      .filter((override) => mentioned(override).length > 0)
      .map((override) => ({
        user_role_id: assignment.id,
        module_id: moduleIds.get(override.module_code) as string,
        can_view: override.view ?? null,
        can_create: override.create ?? null,
        can_update: override.update ?? null,
        can_delete: override.delete ?? null,
        can_import: override.import ?? null,
        can_export: override.export ?? null,
        can_notify: override.notify ?? null,
        is_active: true,
        created_by: editor.userId,
        updated_by: editor.userId,
      }));
    await userModuleAccessRepository.replaceForUserRole(assignment.id, rows, { transaction });
    return overridesDto(organizationId, assignment.id, transaction);
  });
}

export const staffAssignmentService = { lookUp, list, get, assign, update, changeStatus, remove, listOverrides, replaceOverrides };
