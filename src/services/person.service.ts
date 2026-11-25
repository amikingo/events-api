import { toPersonDetailDto, type PersonDetailDto } from "../mappers/registration.mapper.js";
import type { PersonRow } from "../models/person.js";
import { organizationRepository } from "../repositories/organization.repository.js";
import { personRepository } from "../repositories/person.repository.js";
import { registrationRepository } from "../repositories/registration.repository.js";
import { normalizeEthiopianMobile } from "../utils/mobile.js";
import { buildPagination } from "../utils/pagination.js";
import { pickDefined } from "../utils/patch.js";
import type { PersonCreateInput, PersonListQuery, PersonUpdateInput } from "../validators/person.js";
import { ensureFound, runTransaction } from "./helpers.js";

/**
 * Guest profiles (spec §6). Staff find a returning guest within their organization, confirm the identity and select
 * the profile, or create a new one. Deactivated rather than deleted, so registrations keep their guest. `user_id` is
 * never set here: it links a Central Auth account when attendees register themselves (a later phase).
 */
const UPDATABLE_FIELDS = ["first_name", "last_name", "email", "phone", "affiliation_name", "country"] as const;

async function createPerson(organizationId: string, input: PersonCreateInput, actorId: string | null): Promise<PersonRow> {
  return runTransaction(async (transaction) => {
    ensureFound(await organizationRepository.findById(organizationId, { transaction }), "Organization not found");
    return personRepository.create(
      {
        organization_id: organizationId,
        first_name: input.first_name,
        last_name: input.last_name ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        affiliation_name: input.affiliation_name ?? null,
        country: input.country ?? null,
        is_active: input.is_active ?? true,
        user_id: null,
        created_by: actorId,
        updated_by: actorId,
      },
      { transaction },
    );
  });
}

async function listPersons(organizationId: string, query: PersonListQuery): Promise<{ rows: PersonRow[]; count: number }> {
  const { limit, offset } = buildPagination(query);
  return personRepository.listByOrganization(organizationId, {
    q: query.q,
    phoneVariant: query.q === undefined ? null : normalizeEthiopianMobile(query.q),
    isActive: query.is_active,
    limit,
    offset,
  });
}

/** The profile with the guest's registrations in this organization, so staff can confirm who they are. */
async function getPerson(organizationId: string, personId: string): Promise<PersonDetailDto> {
  const person = ensureFound(await personRepository.findByOrganizationAndId(organizationId, personId), "Guest not found");
  return toPersonDetailDto(person, await registrationRepository.listByPerson(organizationId, personId));
}

async function updatePerson(organizationId: string, personId: string, input: PersonUpdateInput, actorId: string | null): Promise<PersonRow> {
  return runTransaction(async (transaction) => {
    ensureFound(await personRepository.findByOrganizationAndId(organizationId, personId, { transaction, lock: true }), "Guest not found");
    const updated = await personRepository.updateByOrganizationAndId(
      organizationId,
      personId,
      { ...pickDefined(input, UPDATABLE_FIELDS), updated_by: actorId },
      { transaction },
    );
    return ensureFound(updated, "Guest not found");
  });
}

/** Activate or deactivate. A deactivated guest keeps their registrations but can't be registered again. */
async function changePersonStatus(organizationId: string, personId: string, isActive: boolean, actorId: string | null): Promise<PersonRow> {
  return runTransaction(async (transaction) => {
    ensureFound(await personRepository.findByOrganizationAndId(organizationId, personId, { transaction, lock: true }), "Guest not found");
    const updated = await personRepository.updateByOrganizationAndId(
      organizationId,
      personId,
      { is_active: isActive, updated_by: actorId },
      { transaction },
    );
    return ensureFound(updated, "Guest not found");
  });
}

export const personService = { createPerson, listPersons, getPerson, updatePerson, changePersonStatus };
