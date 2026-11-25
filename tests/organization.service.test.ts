import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { Transaction } from "sequelize";
import { centralAuthClient } from "../src/clients/central-auth.client.js";
import { CentralAccountNotFoundError, ConflictError, ValidationAppError } from "../src/errors/app-errors.js";
import type { RoleRow } from "../src/models/role.js";
import type { UserRoleRow } from "../src/models/user-role.js";
import { userRoleRepository } from "../src/repositories/user-role.repository.js";
import { branchRepository } from "../src/repositories/branch.repository.js";
import { organizationRepository } from "../src/repositories/organization.repository.js";
import { defaultRolesService } from "../src/services/default-roles.service.js";
import { transactionManager } from "../src/services/helpers.js";
import { organizationService } from "../src/services/organization.service.js";
import { organizationCreateSchema, organizationSettingsUpdateSchema } from "../src/validators/organization.js";
import { assignment, branchRow, IDS, organizationRow, roleRow } from "./helpers/fixtures.js";

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

  await organizationService.updateOrganizationSettings(IDS.orgA, { timezone: "Europe/London", description: undefined }, IDS.user);

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

// --- Phase 2c: name and description, switching off and on, the first Owner at creation ---------------------

test("the owner edits the name and description; the slug is never written, so public links never change", async () => {
  mock.method(organizationRepository, "findById", async () => organizationRow());
  const update = mock.method(organizationRepository, "updateSettings", async () => organizationRow({ name: "Selam Events PLC" }));

  await organizationService.updateOrganizationSettings(IDS.orgA, { name: "Selam Events PLC", description: null }, IDS.user);

  assert.deepEqual(update.mock.calls[0]?.arguments[1], { name: "Selam Events PLC", description: null, updated_by: IDS.user });
  const parsed = organizationSettingsUpdateSchema.safeParse({ name: "Renamed", slug: "renamed" });
  assert.equal(parsed.success, false, "a slug in the body is refused, never silently dropped");
});

test("switching an organization off and on writes is_active only, with the organization locked; the same state changes nothing", async () => {
  const find = mock.method(organizationRepository, "findById", async (_id: string, _options?: unknown) => organizationRow({ is_active: true }));
  const update = mock.method(organizationRepository, "updateSettings", async () => organizationRow({ is_active: false }));

  const off = await organizationService.changeOrganizationStatus(IDS.orgA, false, IDS.user);
  assert.equal(off.is_active, false);
  assert.deepEqual(find.mock.calls[0]?.arguments[1], { transaction: FAKE_TX, lock: true });
  assert.deepEqual(update.mock.calls[0]?.arguments, [IDS.orgA, { is_active: false, updated_by: IDS.user }, { transaction: FAKE_TX }]);

  await organizationService.changeOrganizationStatus(IDS.orgA, true, IDS.user);
  assert.equal(update.mock.callCount(), 1, "already on: nothing written");
});

const FIRST_OWNER = { userId: "7d4b1f0e-2c3a-4e5f-8a9b-0c1d2e3f4a5b", mobile: "+251911234567", firstname: "Hana", middlename: null, lastname: "Bekele" };
const OWNER_ROLE = roleRow({ id: "role-owner", code: "OWNER", name: "Owner" });

function arrangeOwner(options: { person?: typeof FIRST_OWNER | null; elsewhere?: UserRoleRow[] } = {}) {
  const order: string[] = [];
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => {
    order.push("transaction");
    return work(FAKE_TX);
  });
  return {
    order,
    lookUp: mock.method(centralAuthClient, "findUserByMobile", async (_mobile: string) => {
      order.push("lookup");
      return options.person === undefined ? FIRST_OWNER : options.person;
    }),
    lock: mock.method(userRoleRepository, "lockAssignmentsOfUser", async () => {
      order.push("lock");
    }),
    elsewhere: mock.method(userRoleRepository, "listAllByUser", async () => options.elsewhere ?? []),
    roles: mock.method(defaultRolesService, "createDefaultRoles", async () => new Map<string, RoleRow>([["OWNER", OWNER_ROLE]])),
    organization: mock.method(organizationRepository, "create", async () => {
      order.push("organization");
      return organizationRow({ id: IDS.orgB });
    }),
    assign: mock.method(userRoleRepository, "create", async (_values: Partial<UserRoleRow>, _options?: unknown) => {
      order.push("assign");
      return assignment({ id: "assignment-owner" });
    }),
  };
}

test("owner_mobile: the person is looked up first, then the organization, its roles and the Owner assignment are made in one transaction", async () => {
  const fakes = arrangeOwner();

  const result = await organizationService.createOrganization(
    { organization: { name: "Pilot Org", description: undefined }, owner_mobile: "+251911234567" },
    IDS.user,
  );

  assert.deepEqual(fakes.order, ["lookup", "transaction", "lock", "organization", "assign"]);
  assert.deepEqual(fakes.lookUp.mock.calls[0]?.arguments, ["+251911234567"]);
  assert.deepEqual(fakes.assign.mock.calls[0]?.arguments, [
    { user_id: FIRST_OWNER.userId, role_id: OWNER_ROLE.id, organization_id: IDS.orgB, branch_id: null, created_by: IDS.user, updated_by: IDS.user },
    { transaction: FAKE_TX },
  ]);
  assert.deepEqual(result.owner, { user_id: FIRST_OWNER.userId, assignment_id: "assignment-owner" });
});

test("owner_mobile with no Cheche account creates nothing at all (404 central_account_not_found)", async () => {
  const fakes = arrangeOwner({ person: null });
  await assert.rejects(
    organizationService.createOrganization({ organization: { name: "Pilot Org", description: undefined }, owner_mobile: "+251911000000" }, IDS.user),
    CentralAccountNotFoundError,
  );
  assert.deepEqual(fakes.order, ["lookup"], "no transaction opened");
});

test("owner_mobile for someone already staff anywhere is refused before the organization is made", async () => {
  const fakes = arrangeOwner({ elsewhere: [assignment({ organization_id: IDS.orgA })] });
  await assert.rejects(
    organizationService.createOrganization({ organization: { name: "Pilot Org", description: undefined }, owner_mobile: "+251911234567" }, IDS.user),
    ConflictError,
  );
  assert.deepEqual(fakes.order, ["lookup", "transaction", "lock"], "the transaction rolls back with nothing written");
});

test("without owner_mobile, nobody is looked up and owner is null", async () => {
  const fakes = arrangeOwner();
  const result = await organizationService.createOrganization({ organization: { name: "Pilot Org", description: undefined } }, IDS.user);
  assert.equal(result.owner, null);
  assert.equal(fakes.lookUp.mock.callCount(), 0);
  assert.equal(fakes.assign.mock.callCount(), 0);
});
