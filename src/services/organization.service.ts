import type { Transaction } from "sequelize";
import { CentralAccountNotFoundError, ConflictError, ValidationAppError } from "../errors/app-errors.js";
import type { BranchRow } from "../models/branch.js";
import type { OrganizationRow } from "../models/organization.js";
import { branchRepository } from "../repositories/branch.repository.js";
import { organizationRepository } from "../repositories/organization.repository.js";
import { buildPagination } from "../utils/pagination.js";
import { pickDefined } from "../utils/patch.js";
import { slugify } from "../utils/slug.js";
import type { OrganizationCreateInput, OrganizationListQuery, OrganizationSettingsUpdateInput } from "../validators/organization.js";
import type { RoleRow } from "../models/role.js";
import { centralAuthClient } from "../clients/central-auth.client.js";
import { userRoleRepository } from "../repositories/user-role.repository.js";
import { OWNER_ROLE_CODE } from "../utils/default-roles.js";
import { defaultRolesService } from "./default-roles.service.js";
import { staffRules } from "./staff-rules.js";
import { ensureFound, runTransaction } from "./helpers.js";

const MAIN_BRANCH = { code: "MAIN", name: "Main Branch" } as const;

/**
 * A name written in another script (e.g. Amharic) leaves nothing usable after slugify,
 * so the client must send `organization.slug` instead of getting an empty slug saved.
 */
function slugFromName(name: string): string {
  const slug = slugify(name);
  if (slug.length < 2) {
    throw new ValidationAppError("Request validation failed", {
      issues: [
        {
          path: "body.organization.slug",
          message: "A slug cannot be made from this name. Send organization.slug (e.g. \"selam-events\").",
          code: "slug_required",
        },
      ],
    });
  }
  return slug;
}

/** The slug the client sent, or one made from the name (refused with slug_required for e.g. Amharic names). */
function resolveSlug(name: string, slug: string | undefined): string {
  return slug ?? slugFromName(name);
}

export type OrganizationDraft = {
  name: string;
  /** Already resolved with resolveSlug. */
  slug: string;
  description: string | null;
  /** false: the default branch stays hidden and staff never see branches. */
  hasBranches: boolean;
  /** Omitted: the database defaults (ET, Africa/Addis_Ababa, ETB). */
  country?: string | undefined;
  timezone?: string | undefined;
  defaultCurrency?: string | undefined;
  defaultBranch?: { code: string; name: string } | undefined;
};

/**
 * Aggregate write: an organization never exists without its default branch, even when it has no branches
 * (has_branches = false keeps that branch hidden). Runs inside the caller's transaction, so provisioning can add
 * roles and assignments to the same unit of work. The default branch is written by the repository directly, so
 * it never counts as "adding a branch".
 */
async function createOrganizationInTransaction(
  draft: OrganizationDraft,
  actorId: string | null,
  transaction: Transaction,
): Promise<{ organization: OrganizationRow; branches: BranchRow[]; roles: Map<string, RoleRow> }> {
  if (await organizationRepository.findBySlug(draft.slug, { transaction })) {
    throw new ConflictError("Organization slug is already in use", { field: "slug" });
  }

  const organization = await organizationRepository.create(
    {
      name: draft.name,
      slug: draft.slug,
      description: draft.description,
      has_branches: draft.hasBranches,
      ...(draft.country === undefined ? {} : { country: draft.country }),
      ...(draft.timezone === undefined ? {} : { timezone: draft.timezone }),
      ...(draft.defaultCurrency === undefined ? {} : { default_currency: draft.defaultCurrency }),
      created_by: actorId,
      updated_by: actorId,
    },
    { transaction },
  );

  const defaultBranch = await branchRepository.create(
    {
      organization_id: organization.id,
      code: draft.defaultBranch?.code ?? MAIN_BRANCH.code,
      name: draft.defaultBranch?.name ?? MAIN_BRANCH.name,
      description: null,
      is_default: true,
      is_active: true,
      created_by: actorId,
      updated_by: actorId,
    },
    { transaction },
  );

  // Every organization starts with the default OWNER and VIEWER roles, however it is created (app or script).
  const roles = await defaultRolesService.createDefaultRoles(organization.id, actorId, transaction);

  return { organization, branches: [defaultBranch], roles };
}

/** The slug is resolved first, so an unusable name is refused before any transaction opens. */
async function createOrganization(
  input: OrganizationCreateInput,
  actorId: string | null,
): Promise<{ organization: OrganizationRow; branches: BranchRow[]; owner: { user_id: string; assignment_id: string } | null }> {
  const draft: OrganizationDraft = {
    name: input.organization.name,
    slug: resolveSlug(input.organization.name, input.organization.slug),
    description: input.organization.description ?? null,
    hasBranches: input.organization.has_branches ?? false,
    country: input.organization.country,
    timezone: input.organization.timezone,
    defaultCurrency: input.organization.default_currency,
    defaultBranch: input.default_branch,
  };
  // The first Owner (optional, Phase 2c): looked up in auth-cheche before the transaction, so no lock waits on the
  // network; no account means nothing is created at all.
  const owner = input.owner_mobile === undefined ? null : await centralAuthClient.findUserByMobile(input.owner_mobile);
  if (input.owner_mobile !== undefined && !owner) throw new CentralAccountNotFoundError(undefined, { mobile: input.owner_mobile });

  return runTransaction(async (transaction) => {
    if (owner) {
      await userRoleRepository.lockAssignmentsOfUser(owner.userId, { transaction });
      // A new organization's Owner may not be staff anywhere yet (one person, one organization).
      await staffRules.assertNotStaffElsewhere(owner.userId, null, transaction);
    }
    const { organization, branches, roles } = await createOrganizationInTransaction(draft, actorId, transaction);
    if (!owner) return { organization, branches, owner: null };

    const ownerRole = roles.get(OWNER_ROLE_CODE);
    if (!ownerRole) throw new Error(`Default role ${OWNER_ROLE_CODE} is missing from DEFAULT_TENANT_ROLES`);
    const assignment = await userRoleRepository.create(
      { user_id: owner.userId, role_id: ownerRole.id, organization_id: organization.id, branch_id: null, created_by: actorId, updated_by: actorId },
      { transaction },
    );
    return { organization, branches, owner: { user_id: owner.userId, assignment_id: assignment.id } };
  });
}

/**
 * Switch an organization off or back on (platform Super Admin only, enforced by the route). Switched off, its staff
 * can't act (organization_inactive), its events leave the catalog and their links answer 404; nothing is deleted.
 */
async function changeOrganizationStatus(organizationId: string, isActive: boolean, actorId: string | null): Promise<OrganizationRow> {
  return runTransaction(async (transaction) => {
    const current = ensureFound(await organizationRepository.findById(organizationId, { transaction, lock: true }), "Organization not found");
    if (current.is_active === isActive) return current;
    const updated = await organizationRepository.updateSettings(organizationId, { is_active: isActive, updated_by: actorId }, { transaction });
    return ensureFound(updated, "Organization not found");
  });
}

/**
 * Edits the organization's defaults. Existing events keep their own timezone: they copied it when created.
 */
async function updateOrganizationSettings(
  organizationId: string,
  input: OrganizationSettingsUpdateInput,
  actorId: string | null,
): Promise<OrganizationRow> {
  return runTransaction(async (transaction) => {
    ensureFound(await organizationRepository.findById(organizationId, { transaction, lock: true }), "Organization not found");
    const updated = await organizationRepository.updateSettings(
      organizationId,
      { ...pickDefined(input, ["name", "description", "country", "timezone", "default_currency"] as const), updated_by: actorId },
      { transaction },
    );
    return ensureFound(updated, "Organization not found");
  });
}

/** Used by operational scripts that name an organization by slug. */
async function getOrganizationBySlug(slug: string): Promise<OrganizationRow> {
  return ensureFound(await organizationRepository.findBySlug(slug), `Organization "${slug}" not found`);
}

async function listOrganizations(query: OrganizationListQuery): Promise<{ rows: OrganizationRow[]; count: number }> {
  const { limit, offset } = buildPagination(query);
  return organizationRepository.list({ isActive: query.is_active, limit, offset });
}

async function getOrganization(organizationId: string): Promise<OrganizationRow> {
  return ensureFound(await organizationRepository.findById(organizationId), "Organization not found");
}

export const organizationService = {
  createOrganization,
  changeOrganizationStatus,
  createOrganizationInTransaction,
  resolveSlug,
  listOrganizations,
  getOrganization,
  getOrganizationBySlug,
  updateOrganizationSettings,
};
