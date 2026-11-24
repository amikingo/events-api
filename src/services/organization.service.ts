import type { Transaction } from "sequelize";
import { ConflictError, ValidationAppError } from "../errors/app-errors.js";
import type { BranchRow } from "../models/branch.js";
import type { OrganizationRow } from "../models/organization.js";
import { branchRepository } from "../repositories/branch.repository.js";
import { organizationRepository } from "../repositories/organization.repository.js";
import { buildPagination } from "../utils/pagination.js";
import type { OrganizationCreateInput, OrganizationListQuery } from "../validators/organization.js";
import { ensureFound, runTransaction } from "./helpers.js";

const MAIN_BRANCH = { code: "MAIN", name: "Main Branch" } as const;
const SLUG_MAX_LENGTH = 120;

/**
 * Keeps Latin letters and digits only, joined by single hyphens. Cuts to the maximum length
 * before trimming hyphens, so the result never ends in "-" (the same rule the slug validator applies).
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/^-+|-+$/g, "");
}

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
  defaultBranch?: { code: string; name: string } | undefined;
};

/**
 * Aggregate write: an organization never exists without its default branch. Runs inside the caller's
 * transaction, so provisioning can add roles and assignments to the same unit of work.
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
    { name: draft.name, slug: draft.slug, description: draft.description, created_by: actorId, updated_by: actorId },
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
    defaultBranch: input.default_branch,
  };
  return runTransaction((transaction) => createOrganizationInTransaction(draft, actorId, transaction));
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
};
