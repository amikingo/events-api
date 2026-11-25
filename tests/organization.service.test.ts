import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { Transaction } from "sequelize";
import { ValidationAppError } from "../src/errors/app-errors.js";
import { branchRepository } from "../src/repositories/branch.repository.js";
import { organizationRepository } from "../src/repositories/organization.repository.js";
import { defaultRolesService } from "../src/services/default-roles.service.js";
import { transactionManager } from "../src/services/helpers.js";
import { organizationService } from "../src/services/organization.service.js";
import { organizationCreateSchema } from "../src/validators/organization.js";
import { branchRow, IDS, organizationRow } from "./helpers/fixtures.js";

const FAKE_TX = { id: "fake-transaction" } as unknown as Transaction;

beforeEach(() => {
  // The service runs its real logic against a fake transaction and mocked repositories: no database needed.
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
  mock.method(organizationRepository, "findBySlug", async () => null);
  mock.method(organizationRepository, "create", async () => organizationRow());
  mock.method(branchRepository, "create", async () => branchRow());
  mock.method(defaultRolesService, "createDefaultRoles", async () => new Map());
});
afterEach(() => mock.restoreAll());

test("a new organization gets the default OWNER and VIEWER roles in the same transaction, as the script makes them", async () => {
  mock.method(organizationRepository, "create", async () => organizationRow({ id: IDS.orgB }));
  const roles = mock.method(defaultRolesService, "createDefaultRoles", async (_organizationId: string, _actorId: string | null, _tx: Transaction) => new Map());

  await organizationService.createOrganization({ organization: { name: "Pilot Org", description: undefined } }, IDS.user);

  assert.deepEqual(roles.mock.calls[0]?.arguments, [IDS.orgB, IDS.user, FAKE_TX]);
});

test("has_branches defaults to false, and the hidden default branch is still created", async () => {
  const create = mock.method(organizationRepository, "create", async () => organizationRow());
  const createBranch = mock.method(branchRepository, "create", async () => branchRow());

  await organizationService.createOrganization({ organization: { name: "Selam Events", description: undefined } }, null);

  assert.equal(create.mock.calls[0]?.arguments[0]?.has_branches, false, "no branches unless the organizer says so");
  assert.equal(createBranch.mock.callCount(), 1, "the default branch is always created");
});

test("has_branches is stored when the organizer has branches", async () => {
  const create = mock.method(organizationRepository, "create", async () => organizationRow());

  await organizationService.createOrganization(
    { organization: { name: "Selam Events", description: undefined, has_branches: true } },
    null,
  );

  assert.equal(create.mock.calls[0]?.arguments[0]?.has_branches, true);
});

test("organization defaults: omitted ones are left to the database (ET, Africa/Addis_Ababa, ETB); given ones are stored", async () => {
  const create = mock.method(organizationRepository, "create", async () => organizationRow());

  await organizationService.createOrganization({ organization: { name: "Selam Events", description: undefined } }, null);
  await organizationService.createOrganization(
    { organization: { name: "Nairobi Events", description: undefined, country: "KE", timezone: "Africa/Nairobi", default_currency: "KES" } },
    null,
  );

  const [first] = create.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(["country", "timezone", "default_currency"].filter((key) => first !== undefined && key in first), []);
  const [second] = create.mock.calls[1]?.arguments ?? [];
  assert.deepEqual([second?.country, second?.timezone, second?.default_currency], ["KE", "Africa/Nairobi", "KES"]);
});

test("editing the organization's defaults writes only the given fields, inside the transaction", async () => {
  mock.method(organizationRepository, "findById", async () => organizationRow());
  const update = mock.method(organizationRepository, "updateSettings", async () => organizationRow({ timezone: "Europe/London" }));

  await organizationService.updateOrganizationSettings(IDS.orgA, { timezone: "Europe/London" }, IDS.user);

  assert.deepEqual(update.mock.calls[0]?.arguments, [IDS.orgA, { timezone: "Europe/London", updated_by: IDS.user }, { transaction: FAKE_TX }]);
});

/** Creates an organization and returns the slug the service saved. */
async function savedSlug(name: string, slug?: string): Promise<string | undefined> {
  const create = mock.method(organizationRepository, "create", async () => organizationRow());
  const organization = slug === undefined ? { name, description: undefined } : { name, slug, description: undefined };
  await organizationService.createOrganization({ organization }, null);
  return create.mock.calls[0]?.arguments[0]?.slug;
}

test("a name with no Latin letters or digits needs a slug: clear 400, no database work", async () => {
  const run = mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
  for (const name of ["ሰላም ኢቨንትስ", "ሀ A"]) {
    await assert.rejects(
      organizationService.createOrganization({ organization: { name, description: undefined } }, null),
      (error: unknown) => {
        assert.ok(error instanceof ValidationAppError, name);
        assert.equal(error.statusCode, 400);
        assert.deepEqual(
          (error.details as { issues: Array<{ path: string; code: string }> }).issues.map(({ path, code }) => ({ path, code })),
          [{ path: "body.organization.slug", code: "slug_required" }],
        );
        return true;
      },
    );
  }
  assert.equal(run.mock.callCount(), 0, "no transaction is opened");
});

test("a Latin name becomes a slug, accents included; a slug the client sends is used as is", async () => {
  assert.equal(await savedSlug("Selam Events PLC"), "selam-events-plc");
  assert.equal(await savedSlug("Café Addis"), "cafe-addis");
  assert.equal(await savedSlug("ሰላም ኢቨንትስ", "selam-events"), "selam-events");
});

test("a long name is cut to 120 characters without a trailing hyphen, and passes the slug validator", async () => {
  const slug = await savedSlug(`${"a".repeat(119)} events`);
  assert.equal(slug, "a".repeat(119));
  assert.ok(
    organizationCreateSchema.safeParse({ organization: { name: "Long", slug } }).success,
    "the API would accept this slug if a client sent it",
  );
});
