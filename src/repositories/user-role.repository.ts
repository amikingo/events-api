import { col, fn, Op, type CreationAttributes, type Transaction } from "sequelize";
import { Branch, Organization, Role, UserRole } from "../models/index.js";
import type { BranchRow } from "../models/branch.js";
import type { OrganizationRow } from "../models/organization.js";
import type { RoleRow } from "../models/role.js";
import type { UserRoleRow } from "../models/user-role.js";
import { toPlain, toPlainList } from "../utils/sequelize.js";
import { acquireAdvisoryXactLock, lockOptions, txOptions, type RepoOptions, type WriteOptions } from "./helpers.js";

const attributes = [
  "id",
  "user_id",
  "role_id",
  "organization_id",
  "branch_id",
  "is_active",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
] as const satisfies readonly (keyof UserRoleRow)[];

export type AssignmentRow = UserRoleRow & {
  role: RoleRow;
  organization: OrganizationRow | null;
  branch: BranchRow | null;
};

const assignmentIncludes = [
  { model: Role, as: "role", required: true },
  { model: Organization, as: "organization", required: false },
  { model: Branch, as: "branch", required: false },
];

async function listActiveAssignmentsByUser(userId: string, options: RepoOptions = {}): Promise<AssignmentRow[]> {
  const rows = await UserRole.findAll({
    where: { user_id: userId, is_active: true },
    attributes: [...attributes],
    include: assignmentIncludes,
    order: [
      ["organization_id", "ASC"],
      ["branch_id", "ASC"],
      ["role_id", "ASC"],
    ],
    ...txOptions(options),
  });
  return toPlainList<AssignmentRow>(rows);
}

async function findActiveAssignmentByIdAndUser(
  assignmentId: string,
  userId: string,
  options: RepoOptions = {},
): Promise<AssignmentRow | null> {
  const row = await UserRole.findOne({
    where: { id: assignmentId, user_id: userId, is_active: true },
    attributes: [...attributes],
    include: assignmentIncludes,
    ...txOptions(options),
  });
  return toPlain<AssignmentRow>(row);
}

async function findPlatformAssignment(userId: string, roleId: string, options: RepoOptions = {}): Promise<UserRoleRow | null> {
  const row = await UserRole.findOne({
    where: { user_id: userId, role_id: roleId, organization_id: null },
    attributes: [...attributes],
    ...txOptions(options),
    ...lockOptions(options),
  });
  return toPlain<UserRoleRow>(row);
}

/** Every assignment of a person, active or not: the scope-guard trigger counts them all. */
async function listAllByUser(userId: string, options: RepoOptions = {}): Promise<UserRoleRow[]> {
  const rows = await UserRole.findAll({
    where: { user_id: userId },
    attributes: [...attributes],
    order: [
      ["created_at", "ASC"],
      ["id", "ASC"],
    ],
    ...txOptions(options),
  });
  return toPlainList<UserRoleRow>(rows);
}

/** The assignment for exactly this user, role, organization and branch, active or not (mirrors the unique indexes). */
async function findByScope(
  scope: { userId: string; roleId: string; organizationId: string | null; branchId: string | null },
  options: RepoOptions = {},
): Promise<UserRoleRow | null> {
  const row = await UserRole.findOne({
    where: { user_id: scope.userId, role_id: scope.roleId, organization_id: scope.organizationId, branch_id: scope.branchId },
    attributes: [...attributes],
    ...txOptions(options),
    ...lockOptions(options),
  });
  return toPlain<UserRoleRow>(row);
}

/**
 * Serializes assignment writes for one person until the transaction ends, so two concurrent writes
 * cannot both pass the "one person, one organization" check (the trigger alone cannot see uncommitted rows).
 */
async function lockAssignmentsOfUser(userId: string, options: { transaction: Transaction }): Promise<void> {
  await acquireAdvisoryXactLock("user_role_scope", userId, options);
}

async function create(values: CreationAttributes<UserRole>, options: WriteOptions = {}): Promise<UserRoleRow> {
  const row = await UserRole.create(values, txOptions(options));
  return row.get({ plain: true });
}

async function setActive(
  id: string,
  isActive: boolean,
  actorId: string | null,
  options: WriteOptions = {},
): Promise<void> {
  await UserRole.update({ is_active: isActive, updated_by: actorId }, { where: { id }, ...txOptions(options) });
}

// --- Staff management (Phase 2b): an organization's assignments --------------------------------

/** A staff-list row: the assignment with its role and branch. */
export type StaffAssignmentRow = UserRoleRow & { role: RoleRow; branch: BranchRow | null };

const staffIncludes = [
  { model: Role, as: "role", required: true },
  { model: Branch, as: "branch", required: false },
];

async function listByOrganization(
  organizationId: string,
  filters: { isActive?: boolean | undefined; roleId?: string | undefined; branchId?: string | undefined; limit: number; offset: number },
  options: RepoOptions = {},
): Promise<{ rows: StaffAssignmentRow[]; count: number }> {
  const { rows, count } = await UserRole.findAndCountAll({
    where: {
      organization_id: organizationId,
      ...(typeof filters.isActive === "boolean" ? { is_active: filters.isActive } : {}),
      ...(filters.roleId ? { role_id: filters.roleId } : {}),
      ...(filters.branchId ? { branch_id: filters.branchId } : {}),
    },
    attributes: [...attributes],
    include: staffIncludes,
    order: [
      ["is_active", "DESC"],
      ["created_at", "ASC"],
      ["id", "ASC"],
    ],
    limit: filters.limit,
    offset: filters.offset,
    ...txOptions(options),
  });
  return { rows: toPlainList<StaffAssignmentRow>(rows), count };
}

// Keyed by organization_id + id: an assignment id alone is never a tenant boundary.
async function findByOrganizationAndId(organizationId: string, assignmentId: string, options: RepoOptions = {}): Promise<UserRoleRow | null> {
  const row = await UserRole.findOne({
    where: { organization_id: organizationId, id: assignmentId },
    attributes: [...attributes],
    ...txOptions(options),
    ...lockOptions(options),
  });
  return toPlain<UserRoleRow>(row);
}

async function findStaffByOrganizationAndId(
  organizationId: string,
  assignmentId: string,
  options: RepoOptions = {},
): Promise<StaffAssignmentRow | null> {
  const row = await UserRole.findOne({
    where: { organization_id: organizationId, id: assignmentId },
    attributes: [...attributes],
    include: staffIncludes,
    ...txOptions(options),
  });
  return toPlain<StaffAssignmentRow>(row);
}

async function updateRoleAndBranch(
  id: string,
  values: { role_id: string; branch_id: string | null; updated_by: string | null },
  options: WriteOptions = {},
): Promise<void> {
  await UserRole.update(values, { where: { id }, ...txOptions(options) });
}

/** Active assignments of the organization's OWNER role. */
async function countActiveOwners(organizationId: string, options: RepoOptions = {}): Promise<number> {
  return UserRole.count({
    where: { organization_id: organizationId, is_active: true },
    include: [{ model: Role, as: "role", required: true, where: { code: "OWNER", is_active: true }, attributes: [] }],
    ...txOptions(options),
  });
}

/** Active assignments holding a role (switching a role off is refused while any exist). */
async function countActiveByRole(organizationId: string, roleId: string, options: RepoOptions = {}): Promise<number> {
  return UserRole.count({ where: { organization_id: organizationId, role_id: roleId, is_active: true }, ...txOptions(options) });
}

/** Active assignments per role in one organization (the role list's member counts, Phase 2e). One query. */
async function countActiveByRoles(organizationId: string, roleIds: readonly string[], options: RepoOptions = {}): Promise<Map<string, number>> {
  if (roleIds.length === 0) return new Map();
  const rows = (await UserRole.findAll({
    where: { organization_id: organizationId, role_id: { [Op.in]: [...roleIds] }, is_active: true },
    attributes: ["role_id", [fn("COUNT", col("id")), "members"]],
    group: ["role_id"],
    raw: true,
    ...txOptions(options),
  })) as unknown as Array<{ role_id: string; members: string | number }>;
  return new Map(rows.map((row) => [row.role_id, Number(row.members)]));
}

/** Serializes Owner changes in one organization, so two Owners can't remove each other at the same moment. */
async function lockOwnersOfOrganization(organizationId: string, options: { transaction: Transaction }): Promise<void> {
  await acquireAdvisoryXactLock("organization_owners", organizationId, options);
}

export const userRoleRepository = {
  listByOrganization,
  findByOrganizationAndId,
  findStaffByOrganizationAndId,
  updateRoleAndBranch,
  countActiveOwners,
  countActiveByRole,
  countActiveByRoles,
  lockOwnersOfOrganization,
  listActiveAssignmentsByUser,
  findActiveAssignmentByIdAndUser,
  findPlatformAssignment,
  listAllByUser,
  findByScope,
  lockAssignmentsOfUser,
  create,
  setActive,
};
