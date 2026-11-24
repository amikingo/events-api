import { ConflictError, InvalidBranchStateError } from "../errors/app-errors.js";
import type { BranchRow } from "../models/branch.js";
import { branchRepository } from "../repositories/branch.repository.js";
import { organizationRepository } from "../repositories/organization.repository.js";
import { buildPagination } from "../utils/pagination.js";
import { pickDefined } from "../utils/patch.js";
import type { BranchCreateInput, BranchListQuery, BranchUpdateInput } from "../validators/branch.js";
import { ensureFound, runTransaction } from "./helpers.js";

const UPDATABLE_FIELDS = ["code", "name", "description"] as const;

async function createBranch(organizationId: string, input: BranchCreateInput, actorId: string | null): Promise<BranchRow> {
  return runTransaction(async (transaction) => {
    ensureFound(await organizationRepository.findById(organizationId, { transaction }), "Organization not found");

    if (await branchRepository.findByOrganizationAndCode(organizationId, input.code, { transaction })) {
      throw new ConflictError("Branch code must be unique within the organization", { field: "code" });
    }

    // Lock the current default so two concurrent creates cannot both become default.
    const activeDefault = await branchRepository.findActiveDefaultByOrganization(organizationId, { transaction, lock: true });
    if (input.is_default === true && activeDefault) {
      throw new InvalidBranchStateError("The organization already has an active default branch");
    }

    const isDefault = input.is_default === true || !activeDefault;
    if (isDefault && input.is_active === false) {
      throw new InvalidBranchStateError("A default branch must be active");
    }

    return branchRepository.create(
      {
        organization_id: organizationId,
        code: input.code,
        name: input.name,
        description: input.description ?? null,
        is_default: isDefault,
        is_active: input.is_active ?? true,
        created_by: actorId,
        updated_by: actorId,
      },
      { transaction },
    );
  });
}

async function listBranches(organizationId: string, query: BranchListQuery): Promise<{ rows: BranchRow[]; count: number }> {
  const { limit, offset } = buildPagination(query);
  return branchRepository.listByOrganization(organizationId, { isActive: query.is_active, limit, offset });
}

async function getBranch(organizationId: string, branchId: string): Promise<BranchRow> {
  return ensureFound(await branchRepository.findByOrganizationAndId(organizationId, branchId), "Branch not found");
}

async function updateBranch(
  organizationId: string,
  branchId: string,
  input: BranchUpdateInput,
  actorId: string | null,
): Promise<BranchRow> {
  return runTransaction(async (transaction) => {
    ensureFound(
      await branchRepository.findByOrganizationAndId(organizationId, branchId, { transaction, lock: true }),
      "Branch not found",
    );

    const patch = pickDefined(input, UPDATABLE_FIELDS);
    if (patch.code !== undefined) {
      const clash = await branchRepository.findByOrganizationAndCode(organizationId, patch.code, { transaction });
      if (clash && clash.id !== branchId) {
        throw new ConflictError("Branch code must be unique within the organization", { field: "code" });
      }
    }

    const updated = await branchRepository.updateByOrganizationAndId(
      organizationId,
      branchId,
      { ...patch, updated_by: actorId },
      { transaction },
    );
    return ensureFound(updated, "Branch not found");
  });
}

async function changeBranchStatus(
  organizationId: string,
  branchId: string,
  isActive: boolean,
  actorId: string | null,
): Promise<BranchRow> {
  return runTransaction(async (transaction) => {
    const branch = ensureFound(
      await branchRepository.findByOrganizationAndId(organizationId, branchId, { transaction, lock: true }),
      "Branch not found",
    );

    if (!isActive && branch.is_active) {
      if (branch.is_default) throw new InvalidBranchStateError("The default branch cannot be deactivated");
      if ((await branchRepository.countActiveByOrganization(organizationId, { transaction })) <= 1) {
        throw new InvalidBranchStateError("An organization must keep at least one active branch");
      }
    }

    const updated = await branchRepository.updateByOrganizationAndId(
      organizationId,
      branchId,
      { is_active: isActive, updated_by: actorId },
      { transaction },
    );
    return ensureFound(updated, "Branch not found");
  });
}

export const branchService = { createBranch, listBranches, getBranch, updateBranch, changeBranchStatus };
