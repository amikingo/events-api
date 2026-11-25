import {
  BranchInactiveError,
  ConflictError,
  InvalidBranchStateError,
  OrganizationInactiveError,
  RoleInactiveError,
} from "../errors/app-errors.js";
import { branchRepository } from "../repositories/branch.repository.js";
import { organizationRepository } from "../repositories/organization.repository.js";
import { roleRepository } from "../repositories/role.repository.js";
import { userRoleRepository } from "../repositories/user-role.repository.js";
import { OWNER_ROLE_CODE } from "../utils/default-roles.js";
import { ensureFound, runTransaction } from "./helpers.js";
import { organizationService } from "./organization.service.js";
import { staffRules } from "./staff-rules.js";

/**
 * Pilot provisioning, run from operational scripts (no HTTP endpoint yet). Every call is one transaction and
 * supports a preview (apply: false) that checks everything and writes nothing, like the super-admin bootstrap.
 * Friendly errors come first; the database constraints and the scope-guard trigger stay as the backstop.
 */
export type AssignmentAction = "create" | "reactivate" | "unchanged";

export type ProvisionOrganizerInput = {
  name: string;
  slug?: string | undefined;
  ownerUserId: string;
  /** Default false: a hidden MAIN branch is created and staff never see branches. */
  hasBranches?: boolean | undefined;
};
export type ProvisionOrganizerResult = {
  applied: boolean;
  slug: string;
  hasBranches: boolean;
  organizationId: string | null;
  defaultBranchId: string | null;
  /** Role code → role id. */
  roleIds: Record<string, string>;
  ownerAssignmentId: string | null;
};

export type AssignStaffInput = { organizationId: string; userId: string; roleCode: string; branchCode?: string | undefined };
export type AssignStaffResult = {
  action: AssignmentAction;
  applied: boolean;
  assignmentId: string | null;
  branchId: string | null;
};



/** Creates an organization, its MAIN branch, the default OWNER and VIEWER roles, and the owner's assignment. */
async function provisionOrganizer(
  input: ProvisionOrganizerInput,
  actorId: string | null,
  { apply }: { apply: boolean },
): Promise<ProvisionOrganizerResult> {
  const slug = organizationService.resolveSlug(input.name, input.slug);
  const hasBranches = input.hasBranches ?? false;

  return runTransaction(async (transaction) => {
    await userRoleRepository.lockAssignmentsOfUser(input.ownerUserId, { transaction });
    if (await organizationRepository.findBySlug(slug, { transaction })) {
      throw new ConflictError("Organization slug is already in use", { field: "slug" });
    }
    await staffRules.assertNotStaffElsewhere(input.ownerUserId, null, transaction);

    if (!apply) {
      return { applied: false, slug, hasBranches, organizationId: null, defaultBranchId: null, roleIds: {}, ownerAssignmentId: null };
    }

    // Creates the organization, its default branch and its default roles (the same as POST /v1/organizations).
    const { organization, branches, roles } = await organizationService.createOrganizationInTransaction(
      { name: input.name, slug, description: null, hasBranches },
      actorId,
      transaction,
    );
    const ownerRole = roles.get(OWNER_ROLE_CODE);
    if (!ownerRole) throw new Error(`Default role ${OWNER_ROLE_CODE} is missing from DEFAULT_TENANT_ROLES`);

    const owner = await userRoleRepository.create(
      {
        user_id: input.ownerUserId,
        role_id: ownerRole.id,
        organization_id: organization.id,
        branch_id: null,
        created_by: actorId,
        updated_by: actorId,
      },
      { transaction },
    );

    return {
      applied: true,
      slug,
      hasBranches,
      organizationId: organization.id,
      defaultBranchId: branches[0]?.id ?? null,
      roleIds: Object.fromEntries([...roles].map(([code, role]) => [code, role.id])),
      ownerAssignmentId: owner.id,
    };
  });
}

/**
 * Gives a person a tenant role, organization-wide or for one branch. An identical active assignment is left
 * unchanged; an identical inactive one is reactivated.
 */
async function assignStaff(
  input: AssignStaffInput,
  actorId: string | null,
  { apply }: { apply: boolean },
): Promise<AssignStaffResult> {
  const roleCode = input.roleCode.trim().toUpperCase();
  const branchCode = input.branchCode?.trim().toUpperCase();

  return runTransaction(async (transaction) => {
    await userRoleRepository.lockAssignmentsOfUser(input.userId, { transaction });

    const organization = ensureFound(
      await organizationRepository.findById(input.organizationId, { transaction }),
      "Organization not found",
    );
    if (!organization.is_active) throw new OrganizationInactiveError();

    const role = ensureFound(
      await roleRepository.findByOrganizationAndCode(organization.id, roleCode, { transaction }),
      `Role ${roleCode} does not exist in this organization`,
    );
    if (!role.is_active) throw new RoleInactiveError();

    let branchId: string | null = null;
    if (branchCode !== undefined) {
      if (!organization.has_branches) {
        throw new InvalidBranchStateError("This organization has no branches. Add a branch first; that turns branches on.");
      }
      const branch = ensureFound(
        await branchRepository.findByOrganizationAndCode(organization.id, branchCode, { transaction }),
        `Branch ${branchCode} does not exist in this organization`,
      );
      if (!branch.is_active) throw new BranchInactiveError();
      branchId = branch.id;
    }

    await staffRules.assertNotStaffElsewhere(input.userId, organization.id, transaction);

    const existing = await userRoleRepository.findByScope(
      { userId: input.userId, roleId: role.id, organizationId: organization.id, branchId },
      { transaction, lock: true },
    );
    if (existing?.is_active) return { action: "unchanged", applied: false, assignmentId: existing.id, branchId };

    const action: AssignmentAction = existing ? "reactivate" : "create";
    if (!apply) return { action, applied: false, assignmentId: existing?.id ?? null, branchId };

    if (existing) {
      await userRoleRepository.setActive(existing.id, true, actorId, { transaction });
      return { action, applied: true, assignmentId: existing.id, branchId };
    }
    const created = await userRoleRepository.create(
      {
        user_id: input.userId,
        role_id: role.id,
        organization_id: organization.id,
        branch_id: branchId,
        created_by: actorId,
        updated_by: actorId,
      },
      { transaction },
    );
    return { action, applied: true, assignmentId: created.id, branchId };
  });
}

export const organizationProvisioningService = { provisionOrganizer, assignStaff };
