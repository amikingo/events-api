import type { CreationAttributes } from "sequelize";
import { Branch, Organization, Role, UserRole } from "../models/index.js";
import type { BranchRow } from "../models/branch.js";
import type { OrganizationRow } from "../models/organization.js";
import type { RoleRow } from "../models/role.js";
import type { UserRoleRow } from "../models/user-role.js";
import { toPlain, toPlainList } from "../utils/sequelize.js";
import { lockOptions, txOptions, type RepoOptions, type WriteOptions } from "./helpers.js";

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

export const userRoleRepository = {
  listActiveAssignmentsByUser,
  findActiveAssignmentByIdAndUser,
  findPlatformAssignment,
  create,
  setActive,
};
