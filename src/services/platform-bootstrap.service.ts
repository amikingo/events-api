import { roleRepository } from "../repositories/role.repository.js";
import { userRoleRepository } from "../repositories/user-role.repository.js";
import { SUPER_ADMIN_ROLE_CODE } from "../utils/rbac.js";
import { ensureFound, runTransaction } from "./helpers.js";

export type BootstrapAction = "create" | "reactivate" | "unchanged";

/**
 * Idempotent: running it twice is a no-op. With apply=false it reports the plan and writes nothing.
 * The Central Auth user id is environment-specific, which is why this is a script and not a migration.
 */
async function assignSuperAdmin(
  userId: string,
  { apply }: { apply: boolean },
): Promise<{ action: BootstrapAction; applied: boolean; assignmentId: string | null }> {
  return runTransaction(async (transaction) => {
    const role = ensureFound(
      await roleRepository.findPlatformRoleByCode(SUPER_ADMIN_ROLE_CODE, { transaction }),
      "SUPER_ADMIN platform role is missing; run the migrations first",
    );
    const existing = await userRoleRepository.findPlatformAssignment(userId, role.id, { transaction, lock: true });

    if (existing?.is_active) return { action: "unchanged", applied: false, assignmentId: existing.id };
    const action: BootstrapAction = existing ? "reactivate" : "create";
    if (!apply) return { action, applied: false, assignmentId: existing?.id ?? null };

    if (existing) {
      await userRoleRepository.setActive(existing.id, true, null, { transaction });
      return { action, applied: true, assignmentId: existing.id };
    }
    const created = await userRoleRepository.create(
      { user_id: userId, role_id: role.id, organization_id: null, branch_id: null, created_by: null, updated_by: null },
      { transaction },
    );
    return { action, applied: true, assignmentId: created.id };
  });
}

export const platformBootstrapService = { assignSuperAdmin };
