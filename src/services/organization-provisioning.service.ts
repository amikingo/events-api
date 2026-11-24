import type { Transaction } from "sequelize";
import {
  BranchInactiveError,
  ConflictError,
  OrganizationInactiveError,
  RoleInactiveError,
} from "../errors/app-errors.js";
import type { RoleRow } from "../models/role.js";
import { branchRepository } from "../repositories/branch.repository.js";
import { moduleRepository } from "../repositories/module.repository.js";
import { organizationRepository } from "../repositories/organization.repository.js";
import { roleModuleAccessRepository } from "../repositories/role-module-access.repository.js";
import { roleRepository } from "../repositories/role.repository.js";
import { userRoleRepository } from "../repositories/user-role.repository.js";
import { DEFAULT_TENANT_ROLES, OWNER_ROLE_CODE } from "../utils/default-roles.js";
import type { PermissionAction, PermissionField } from "../utils/rbac.js";
import { ensureFound, runTransaction } from "./helpers.js";
import { organizationService } from "./organization.service.js";

/**
 * Pilot provisioning, run from operational scripts (no HTTP endpoint yet). Every call is one transaction and
 * supports a preview (apply: false) that checks everything and writes nothing, like the super-admin bootstrap.
 * Friendly errors come first; the database constraints and the scope-guard trigger stay as the backstop.
 */
export type AssignmentAction = "create" | "reactivate" | "unchanged";

export type ProvisionOrganizerInput = { name: string; slug?: string | undefined; ownerUserId: string };
export type ProvisionOrganizerResult = {
  applied: boolean;
  slug: string;
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

const ELSEWHERE_MESSAGE =
  "This person already has assignments in another organization or at platform level (inactive ones count too)";

function permissionFlags(actions: readonly PermissionAction[]): Record<PermissionField, boolean> {
  return {
    can_view: actions.includes("view"),
    can_create: actions.includes("create"),
    can_update: actions.includes("update"),
    can_delete: actions.includes("delete"),
    can_import: actions.includes("import"),
    can_export: actions.includes("export"),
    can_notify: actions.includes("notify"),
  };
}

/**
 * Mirrors fn_user_role_scope_guard: a person is platform staff or staff of exactly one organization, and
 * every assignment counts, active or not. `organizationId` null means "a brand-new organization".
 */
async function assertNotStaffElsewhere(userId: string, organizationId: string | null, transaction: Transaction): Promise<void> {
  const assignments = await userRoleRepository.listAllByUser(userId, { transaction });
  if (assignments.some((assignment) => organizationId === null || assignment.organization_id !== organizationId)) {
    throw new ConflictError(ELSEWHERE_MESSAGE, { field: "user_id" });
  }
}

async function createDefaultRoles(
  organizationId: string,
  actorId: string | null,
  transaction: Transaction,
): Promise<Map<string, RoleRow>> {
  const modules = await moduleRepository.listActiveOrdered({ transaction });
  const moduleIdByCode = new Map(modules.filter((row) => row.is_permission).map((row) => [row.code, row.id]));

  const roles = new Map<string, RoleRow>();
  for (const template of DEFAULT_TENANT_ROLES) {
    const role = await roleRepository.create(
      {
        organization_id: organizationId,
        code: template.code,
        name: template.name,
        description: template.description,
        is_active: true,
        created_by: actorId,
        updated_by: actorId,
      },
      { transaction },
    );
    const grants = template.grants.map((grant) => {
      const moduleId = moduleIdByCode.get(grant.moduleCode);
      if (!moduleId) throw new Error(`Module ${grant.moduleCode} is not seeded; run the migrations first`);
      return { role_id: role.id, module_id: moduleId, ...permissionFlags(grant.actions), created_by: actorId, updated_by: actorId };
    });
    await roleModuleAccessRepository.bulkCreate(grants, { transaction });
    roles.set(template.code, role);
  }
  return roles;
}

/** Creates an organization, its MAIN branch, the default OWNER and VIEWER roles, and the owner's assignment. */
async function provisionOrganizer(
  input: ProvisionOrganizerInput,
  actorId: string | null,
  { apply }: { apply: boolean },
): Promise<ProvisionOrganizerResult> {
  const slug = organizationService.resolveSlug(input.name, input.slug);

  return runTransaction(async (transaction) => {
    await userRoleRepository.lockAssignmentsOfUser(input.ownerUserId, { transaction });
    if (await organizationRepository.findBySlug(slug, { transaction })) {
      throw new ConflictError("Organization slug is already in use", { field: "slug" });
    }
    await assertNotStaffElsewhere(input.ownerUserId, null, transaction);

    if (!apply) {
      return { applied: false, slug, organizationId: null, defaultBranchId: null, roleIds: {}, ownerAssignmentId: null };
    }

    const { organization, branches } = await organizationService.createOrganizationInTransaction(
      { name: input.name, slug, description: null },
      actorId,
      transaction,
    );
    const roles = await createDefaultRoles(organization.id, actorId, transaction);
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
      const branch = ensureFound(
        await branchRepository.findByOrganizationAndCode(organization.id, branchCode, { transaction }),
        `Branch ${branchCode} does not exist in this organization`,
      );
      if (!branch.is_active) throw new BranchInactiveError();
      branchId = branch.id;
    }

    await assertNotStaffElsewhere(input.userId, organization.id, transaction);

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
