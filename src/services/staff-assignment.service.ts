import type { Transaction } from "sequelize";
import { centralAuthClient, type CentralUser } from "../clients/central-auth.client.js";
import {
  BranchInactiveError,
  CentralAccountNotFoundError,
  InvalidBranchStateError,
  LastOwnerAssignmentError,
  OrganizationInactiveError,
  RoleInactiveError,
} from "../errors/app-errors.js";
import { toStaffAssignmentDto, toStaffProfileDto, type StaffAssignmentDto, type StaffProfileDto } from "../mappers/staff.mapper.js";
import type { RoleRow } from "../models/role.js";
import { branchRepository } from "../repositories/branch.repository.js";
import { organizationRepository } from "../repositories/organization.repository.js";
import { roleRepository } from "../repositories/role.repository.js";
import { userRoleRepository, type StaffAssignmentRow } from "../repositories/user-role.repository.js";
import { OWNER_ROLE_CODE } from "../utils/default-roles.js";
import { logger } from "../utils/logger.js";
import { buildPagination } from "../utils/pagination.js";
import type { StaffAssignmentCreateInput, StaffAssignmentListQuery, StaffAssignmentUpdateInput } from "../validators/staff-assignment.js";
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

async function list(organizationId: string, query: StaffAssignmentListQuery): Promise<{ rows: StaffAssignmentDto[]; count: number }> {
  const { limit, offset } = buildPagination(query);
  const { rows, count } = await userRoleRepository.listByOrganization(organizationId, { isActive: query.is_active, limit, offset });
  const profiles = await profilesOf(rows.map((row) => row.user_id));
  return { rows: rows.map((row) => toStaffAssignmentDto(row, profiles.get(row.user_id))), count };
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

/** Another role or branch for the same person. The last active Owner keeps the Owner role. */
async function update(
  organizationId: string,
  assignmentId: string,
  input: StaffAssignmentUpdateInput,
  actorId: string | null,
): Promise<StaffAssignmentDto> {
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
    await userRoleRepository.updateRoleAndBranch(current.id, { role_id: nextRole.id, branch_id: branchId, updated_by: actorId }, { transaction });
    return staffDto(organizationId, current.id, undefined, transaction);
  });
  return { ...assignment, profile: toStaffProfileDto((await profilesOf([assignment.user_id])).get(assignment.user_id)) };
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
      await userRoleRepository.setActive(current.id, isActive, actorId, { transaction });
    }
    return staffDto(organizationId, current.id, undefined, transaction);
  });
  return { ...assignment, profile: toStaffProfileDto((await profilesOf([assignment.user_id])).get(assignment.user_id)) };
}

export const staffAssignmentService = { lookUp, list, assign, update, changeStatus };
