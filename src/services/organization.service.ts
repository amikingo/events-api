import type { Transaction } from "sequelize";
import { ConflictError, ValidationAppError } from "../errors/app-errors.js";
import type { BranchRow } from "../models/branch.js";
import type { OrganizationRow } from "../models/organization.js";
import { branchRepository } from "../repositories/branch.repository.js";
import { organizationRepository } from "../repositories/organization.repository.js";
import { buildPagination } from "../utils/pagination.js";
import { pickDefined } from "../utils/patch.js";
import { slugify } from "../utils/slug.js";
import type { OrganizationCreateInput, OrganizationListQuery, OrganizationSettingsUpdateInput } from "../validators/organization.js";
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
): Promise<{ organization: OrganizationRow; branches: BranchRow[] }> {
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

  return { organization, branches: [defaultBranch] };
}

/** The slug is resolved first, so an unusable name is refused before any transaction opens. */
async function createOrganization(
  input: OrganizationCreateInput,
  actorId: string | null,
): Promise<{ organization: OrganizationRow; branches: BranchRow[] }> {
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
  return runTransaction((transaction) => createOrganizationInTransaction(draft, actorId, transaction));
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
      { ...pickDefined(input, ["country", "timezone", "default_currency"] as const), updated_by: actorId },
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
  createOrganizationInTransaction,
  resolveSlug,
  listOrganizations,
  getOrganization,
  getOrganizationBySlug,
  updateOrganizationSettings,
};
