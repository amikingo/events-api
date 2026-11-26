import type { Transaction } from "sequelize";
import type { CentralUser } from "../clients/central-auth.client.js";
import { ConflictError, LastSuperAdminError, OwnAssignmentError, RoleInactiveError } from "../errors/app-errors.js";
import { toStaffAssignmentDto, toStaffProfileDto, type StaffAssignmentDto } from "../mappers/staff.mapper.js";
import type { RoleRow } from "../models/role.js";
import { roleRepository } from "../repositories/role.repository.js";
import { userRoleRepository } from "../repositories/user-role.repository.js";
import { buildPagination } from "../utils/pagination.js";
import { SUPER_ADMIN_ROLE_CODE } from "../utils/rbac.js";
import type { PlatformStaffCreateInput, PlatformStaffListQuery } from "../validators/platform.js";
import { ensureFound, runTransaction } from "./helpers.js";
import { staffAccounts } from "./staff-accounts.js";

/**
 * Platform staff (Phase 2e, decided 26 November 2026): people with a platform role (no organization). Managed at
 * platform scope only. Rules:
 * - a person is platform staff or tenant staff, never both (the fn_user_role_scope_guard trigger agrees; the API
 *   refuses first with 409 conflict, field user_id);
 * - the platform always keeps an active Super Admin (409 last_super_admin), under the Super Admin lock;
 * - nobody changes or deletes their own platform assignment (409 own_assignment);
 * - a Cheche account may be created on the way, as for tenant staff (shared staff-accounts.ts).
 */
export type PlatformAssignOutcome = "CREATED" | "REACTIVATED" | "UNCHANGED";

async function activePlatformRole(roleId: string, transaction: Transaction): Promise<RoleRow> {
  const role = ensureFound(await roleRepository.findPlatformById(roleId, { transaction, lock: true }), "Role not found");
  if (!role.is_active) throw new RoleInactiveError();
  return role;
}

/** Refuses someone who already has an assignment in any organization (inactive ones count, as in the trigger). */
async function assertNotTenantStaff(userId: string, transaction: Transaction): Promise<void> {
  const assignments = await userRoleRepository.listAllByUser(userId, { transaction });
  if (assignments.some((assignment) => assignment.organization_id !== null)) {
    throw new ConflictError("This person is staff of an organization (inactive assignments count too), so they can't be platform staff", {
      field: "user_id",
    });
  }
}

/** Refuses a change that would leave no active Super Admin. Call under lockSuperAdmins. */
async function keepASuperAdmin(role: RoleRow, transaction: Transaction): Promise<void> {
  if (role.code !== SUPER_ADMIN_ROLE_CODE) return;
  if ((await userRoleRepository.countActivePlatformByRole(role.id, { transaction })) <= 1) throw new LastSuperAdminError();
}

async function dto(assignmentId: string, user?: CentralUser, transaction?: Transaction): Promise<StaffAssignmentDto> {
  const row = ensureFound(await userRoleRepository.findPlatformStaffById(assignmentId, { transaction: transaction ?? null }), "Staff assignment not found");
  return toStaffAssignmentDto(row, user);
}

async function list(query: PlatformStaffListQuery): Promise<{ rows: StaffAssignmentDto[]; count: number }> {
  const { limit, offset } = buildPagination(query);
  const { rows, count } = await userRoleRepository.listPlatform({ isActive: query.is_active, roleId: query.role_id, limit, offset });
  const profiles = await staffAccounts.profilesOf(rows.map((row) => row.user_id));
  return { rows: rows.map((row) => toStaffAssignmentDto(row, profiles.get(row.user_id))), count };
}

async function get(assignmentId: string): Promise<StaffAssignmentDto> {
  const assignment = await dto(assignmentId);
  return { ...assignment, profile: toStaffProfileDto((await staffAccounts.profilesOf([assignment.user_id])).get(assignment.user_id)) };
}

/** Gives the person behind this mobile a platform role (creating their Cheche account when asked). */
async function assign(
  input: PlatformStaffCreateInput,
  actorId: string | null,
): Promise<{ assignment: StaffAssignmentDto; outcome: PlatformAssignOutcome; accountCreated: boolean }> {
  const { user, created: accountCreated } = await staffAccounts.accountFor(input);
  return runTransaction(async (transaction) => {
    await userRoleRepository.lockAssignmentsOfUser(user.userId, { transaction });
    const role = await activePlatformRole(input.role_id, transaction);
    await assertNotTenantStaff(user.userId, transaction);
    const existing = await userRoleRepository.findByScope({ userId: user.userId, roleId: role.id, organizationId: null, branchId: null }, { transaction, lock: true });
    let assignmentId: string;
    let outcome: PlatformAssignOutcome;
    if (existing?.is_active) {
      assignmentId = existing.id;
      outcome = "UNCHANGED";
    } else if (existing) {
      await userRoleRepository.setActive(existing.id, true, actorId, { transaction });
      assignmentId = existing.id;
      outcome = "REACTIVATED";
    } else {
      const created = await userRoleRepository.create(
        { user_id: user.userId, role_id: role.id, organization_id: null, branch_id: null, created_by: actorId, updated_by: actorId },
        { transaction },
      );
      assignmentId = created.id;
      outcome = "CREATED";
    }
    return { assignment: await dto(assignmentId, user, transaction), outcome, accountCreated };
  });
}

/** Another platform role for the same person. The last active Super Admin keeps the role; never your own. */
async function update(assignmentId: string, roleId: string, actorId: string | null): Promise<StaffAssignmentDto> {
  const assignment = await runTransaction(async (transaction) => {
    await userRoleRepository.lockSuperAdmins({ transaction });
    const current = ensureFound(await userRoleRepository.findPlatformById(assignmentId, { transaction, lock: true }), "Staff assignment not found");
    if (actorId !== null && current.user_id === actorId) throw new OwnAssignmentError("You can't change your own platform role. Ask another Super Admin");
    const currentRole = ensureFound(await roleRepository.findPlatformById(current.role_id, { transaction }), "Role not found");
    const nextRole = await activePlatformRole(roleId, transaction);
    if (current.is_active && nextRole.id !== currentRole.id) await keepASuperAdmin(currentRole, transaction);
    await userRoleRepository.updateRoleAndBranch(current.id, { role_id: nextRole.id, branch_id: null, updated_by: actorId }, { transaction });
    return dto(current.id, undefined, transaction);
  });
  return { ...assignment, profile: toStaffProfileDto((await staffAccounts.profilesOf([assignment.user_id])).get(assignment.user_id)) };
}

/** Switch a platform assignment off or on. The last active Super Admin stays on; never your own. */
async function changeStatus(assignmentId: string, isActive: boolean, actorId: string | null): Promise<StaffAssignmentDto> {
  const assignment = await runTransaction(async (transaction) => {
    await userRoleRepository.lockSuperAdmins({ transaction });
    const current = ensureFound(await userRoleRepository.findPlatformById(assignmentId, { transaction, lock: true }), "Staff assignment not found");
    if (actorId !== null && current.user_id === actorId) throw new OwnAssignmentError("You can't switch your own platform assignment. Ask another Super Admin");
    if (current.is_active !== isActive) {
      const role = ensureFound(await roleRepository.findPlatformById(current.role_id, { transaction }), "Role not found");
      if (!isActive) await keepASuperAdmin(role, transaction);
      if (isActive && !role.is_active) throw new RoleInactiveError();
      await userRoleRepository.setActive(current.id, isActive, actorId, { transaction });
    }
    return dto(current.id, undefined, transaction);
  });
  return { ...assignment, profile: toStaffProfileDto((await staffAccounts.profilesOf([assignment.user_id])).get(assignment.user_id)) };
}

/** Deletes a platform assignment for good. The last active Super Admin stays; never your own. */
async function remove(assignmentId: string, actorId: string | null): Promise<void> {
  await runTransaction(async (transaction) => {
    await userRoleRepository.lockSuperAdmins({ transaction });
    const current = ensureFound(await userRoleRepository.findPlatformById(assignmentId, { transaction, lock: true }), "Staff assignment not found");
    if (actorId !== null && current.user_id === actorId) throw new OwnAssignmentError("You can't delete your own platform assignment. Ask another Super Admin");
    const role = ensureFound(await roleRepository.findPlatformById(current.role_id, { transaction }), "Role not found");
    if (current.is_active) await keepASuperAdmin(role, transaction);
    await userRoleRepository.deletePlatformById(current.id, { transaction });
  });
}

export const platformStaffService = { list, get, assign, update, changeStatus, remove };
