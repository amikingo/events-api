import type { Transaction } from "sequelize";
import { ConflictError } from "../errors/app-errors.js";
import { userRoleRepository } from "../repositories/user-role.repository.js";

/**
 * Rules shared by every path that gives someone a role: the provisioning scripts and the staff endpoints (Phase 2b).
 * One person belongs to one organization, or to the platform; inactive assignments count too, as in the
 * fn_user_role_scope_guard trigger.
 */
const ELSEWHERE_MESSAGE =
  "This person already has assignments in another organization or at platform level (inactive ones count too)";

async function assertNotStaffElsewhere(userId: string, organizationId: string | null, transaction: Transaction): Promise<void> {
  const assignments = await userRoleRepository.listAllByUser(userId, { transaction });
  if (assignments.some((assignment) => organizationId === null || assignment.organization_id !== organizationId)) {
    throw new ConflictError(ELSEWHERE_MESSAGE, { field: "user_id" });
  }
}

export const staffRules = { assertNotStaffElsewhere };
