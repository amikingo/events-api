import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { Transaction } from "sequelize";
import { NotFoundError } from "../src/errors/app-errors.js";
import type { PersonRow } from "../src/models/person.js";
import { organizationRepository } from "../src/repositories/organization.repository.js";
import { personRepository } from "../src/repositories/person.repository.js";
import { registrationRepository } from "../src/repositories/registration.repository.js";
import { transactionManager } from "../src/services/helpers.js";
import { personService } from "../src/services/person.service.js";
import { eventRow, IDS, organizationRow, personRow, registrationRow, ticketTypeRow } from "./helpers/fixtures.js";

/** The guest-profile service against mocked repositories and a fake transaction: no database needed. */
const FAKE_TX = { id: "fake-transaction" } as unknown as Transaction;
const NOT_SENT = { last_name: undefined, email: undefined, phone: undefined, affiliation_name: undefined, country: undefined };

beforeEach(() => {
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
});
afterEach(() => mock.restoreAll());

test("a new guest keeps only the fields given, scoped to the organization and the transaction, never linked to an account", async () => {
  mock.method(organizationRepository, "findById", async () => organizationRow());
  const create = mock.method(personRepository, "create", async (_values: Partial<PersonRow>, _options?: unknown) => personRow());

  await personService.createPerson(IDS.orgA, { ...NOT_SENT, first_name: "Hana", phone: "+251911234567" }, IDS.user);

  const [values, options] = create.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(values, {
    organization_id: IDS.orgA,
    first_name: "Hana",
    last_name: null,
    email: null,
    phone: "+251911234567",
    affiliation_name: null,
    country: null,
    is_active: true,
    user_id: null,
    created_by: IDS.user,
    updated_by: IDS.user,
  });
  assert.deepEqual(options, { transaction: FAKE_TX });
});

test("searching by an Ethiopian mobile also matches its +251 form", async () => {
  const list = mock.method(personRepository, "listByOrganization", async (_organizationId: string, _filters: unknown) => ({ rows: [], count: 0 }));

  await personService.listPersons(IDS.orgA, { page: 1, pageSize: 20, q: "0911234567", is_active: undefined });
  await personService.listPersons(IDS.orgA, { page: 2, pageSize: 10, q: "Hana", is_active: true });

  const [organizationId, first] = list.mock.calls[0]?.arguments ?? [];
  assert.equal(organizationId, IDS.orgA);
  assert.deepEqual(first, { q: "0911234567", phoneVariant: "+251911234567", isActive: undefined, limit: 20, offset: 0 });
  assert.deepEqual(list.mock.calls[1]?.arguments[1], { q: "Hana", phoneVariant: null, isActive: true, limit: 10, offset: 10 });
});

test("a profile shows the guest's registrations in this organization, so staff can confirm who they are", async () => {
  mock.method(personRepository, "findByOrganizationAndId", async () => personRow());
  const listByPerson = mock.method(registrationRepository, "listByPerson", async () => [
    { ...registrationRow(), event: { ...eventRow(), status: "PUBLISHED" as const }, ticketType: ticketTypeRow() },
  ]);

  const detail = await personService.getPerson(IDS.orgA, IDS.person);

  assert.deepEqual(listByPerson.mock.calls[0]?.arguments, [IDS.orgA, IDS.person]);
  assert.equal(detail.registrations.length, 1);
  assert.deepEqual([detail.registrations[0]?.code, detail.registrations[0]?.ticket_type.code], ["K7M2Q9XP", "GA"]);
});

test("an update persists only allow-listed fields; a guest of another organization is not found", async () => {
  mock.method(personRepository, "findByOrganizationAndId", async () => personRow());
  const update = mock.method(
    personRepository,
    "updateByOrganizationAndId",
    async (_o: string, _id: string, _values: Partial<PersonRow>, _options?: unknown) => personRow({ email: null }),
  );

  await personService.updatePerson(IDS.orgA, IDS.person, { ...NOT_SENT, first_name: undefined, email: null }, IDS.user);
  const [, , values, options] = update.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(values, { email: null, updated_by: IDS.user });
  assert.deepEqual(options, { transaction: FAKE_TX });

  mock.method(personRepository, "findByOrganizationAndId", async () => null);
  await assert.rejects(personService.updatePerson(IDS.orgB, IDS.person, { ...NOT_SENT, first_name: "X" }, IDS.user), NotFoundError);
  await assert.rejects(personService.getPerson(IDS.orgB, IDS.person), NotFoundError);
});
