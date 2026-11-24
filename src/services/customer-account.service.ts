import { ValidationAppError } from "../errors/app-errors.js";
import type { CustomerAccountRow } from "../models/customer-account.js";
import { customerAccountRepository } from "../repositories/customer-account.repository.js";
import { organizationRepository } from "../repositories/organization.repository.js";
import { buildPagination } from "../utils/pagination.js";
import { pickDefined } from "../utils/patch.js";
import type {
  CustomerAccountCreateInput,
  CustomerAccountListQuery,
  CustomerAccountUpdateInput,
} from "../validators/customer-account.js";
import { ensureFound, runTransaction } from "./helpers.js";

/**
 * Clients commissioning events (spec §3). Deactivated rather than deleted, so events that reference a client keep
 * their history.
 */
const UPDATABLE_FIELDS = [
  "name",
  "kind",
  "type",
  "primary_contact_name",
  "primary_contact_email",
  "primary_contact_phone",
] as const;

async function createCustomerAccount(
  organizationId: string,
  input: CustomerAccountCreateInput,
  actorId: string | null,
): Promise<CustomerAccountRow> {
  return runTransaction(async (transaction) => {
    ensureFound(await organizationRepository.findById(organizationId, { transaction }), "Organization not found");
    return customerAccountRepository.create(
      {
        organization_id: organizationId,
        name: input.name,
        kind: input.kind ?? "ORGANIZATION",
        type: input.type ?? null,
        primary_contact_name: input.primary_contact_name ?? null,
        primary_contact_email: input.primary_contact_email ?? null,
        primary_contact_phone: input.primary_contact_phone ?? null,
        is_active: input.is_active ?? true,
        created_by: actorId,
        updated_by: actorId,
      },
      { transaction },
    );
  });
}

async function listCustomerAccounts(
  organizationId: string,
  query: CustomerAccountListQuery,
): Promise<{ rows: CustomerAccountRow[]; count: number }> {
  const { limit, offset } = buildPagination(query);
  return customerAccountRepository.listByOrganization(organizationId, { isActive: query.is_active, limit, offset });
}

async function getCustomerAccount(organizationId: string, customerAccountId: string): Promise<CustomerAccountRow> {
  return ensureFound(await customerAccountRepository.findByOrganizationAndId(organizationId, customerAccountId), "Client not found");
}

async function updateCustomerAccount(
  organizationId: string,
  customerAccountId: string,
  input: CustomerAccountUpdateInput,
  actorId: string | null,
): Promise<CustomerAccountRow> {
  return runTransaction(async (transaction) => {
    const current = ensureFound(
      await customerAccountRepository.findByOrganizationAndId(organizationId, customerAccountId, { transaction, lock: true }),
      "Client not found",
    );

    const patch = pickDefined(input, UPDATABLE_FIELDS);
    // An individual has no sector: the result after this PATCH must not combine INDIVIDUAL with a type.
    const kind = patch.kind ?? current.kind;
    const type = patch.type === undefined ? current.type : patch.type;
    if (kind === "INDIVIDUAL" && type !== null) {
      throw new ValidationAppError("Request validation failed", {
        issues: [
          {
            path: "body.type",
            message: "An individual client has no sector type. Send type: null together with kind: INDIVIDUAL.",
            code: "type_not_allowed_for_individual",
          },
        ],
      });
    }

    const updated = await customerAccountRepository.updateByOrganizationAndId(
      organizationId,
      customerAccountId,
      { ...patch, updated_by: actorId },
      { transaction },
    );
    return ensureFound(updated, "Client not found");
  });
}

async function changeCustomerAccountStatus(
  organizationId: string,
  customerAccountId: string,
  isActive: boolean,
  actorId: string | null,
): Promise<CustomerAccountRow> {
  return runTransaction(async (transaction) => {
    ensureFound(
      await customerAccountRepository.findByOrganizationAndId(organizationId, customerAccountId, { transaction, lock: true }),
      "Client not found",
    );
    const updated = await customerAccountRepository.updateByOrganizationAndId(
      organizationId,
      customerAccountId,
      { is_active: isActive, updated_by: actorId },
      { transaction },
    );
    return ensureFound(updated, "Client not found");
  });
}

export const customerAccountService = {
  createCustomerAccount,
  listCustomerAccounts,
  getCustomerAccount,
  updateCustomerAccount,
  changeCustomerAccountStatus,
};
