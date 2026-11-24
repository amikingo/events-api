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

/**
 * Aggregate service: an organization never exists without its default branch,
 * so both rows are written in one managed transaction.
 */
async function createOrganization(
  input: OrganizationCreateInput,
  actorId: string | null,
): Promise<{ organization: OrganizationRow; branches: BranchRow[] }> {
  const slug = input.organization.slug ?? slugFromName(input.organization.name);

  return runTransaction(async (transaction) => {
    if (await organizationRepository.findBySlug(slug, { transaction })) {
      throw new ConflictError("Organization slug is already in use", { field: "slug" });
    }

    const organization = await organizationRepository.create(
      {
        name: input.organization.name,
        slug,
        description: input.organization.description ?? null,
        created_by: actorId,
        updated_by: actorId,
      },
      { transaction },
    );

    const defaultBranch = await branchRepository.create(
      {
        organization_id: organization.id,
        code: input.default_branch?.code ?? MAIN_BRANCH.code,
        name: input.default_branch?.name ?? MAIN_BRANCH.name,
        description: null,
        is_default: true,
        is_active: true,
        created_by: actorId,
        updated_by: actorId,
      },
      { transaction },
    );

    return { organization, branches: [defaultBranch] };
  });
}

async function listOrganizations(query: OrganizationListQuery): Promise<{ rows: OrganizationRow[]; count: number }> {
  const { limit, offset } = buildPagination(query);
  return organizationRepository.list({ isActive: query.is_active, limit, offset });
}

async function getOrganization(organizationId: string): Promise<OrganizationRow> {
  return ensureFound(await organizationRepository.findById(organizationId), "Organization not found");
}

export const organizationService = { createOrganization, listOrganizations, getOrganization };
