import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createApp } from "../../src/app.js";
import { sequelize } from "../../src/db.js";
import { ConflictError, StaffAssignmentNotFoundError } from "../../src/errors/app-errors.js";
import { migrator } from "../../src/migrator.js";
import { Branch, UserModuleAccess } from "../../src/models/index.js";
import { moduleRepository } from "../../src/repositories/module.repository.js";
import { userRoleRepository } from "../../src/repositories/user-role.repository.js";
import { authTokenService } from "../../src/services/auth-token.service.js";
import { branchService } from "../../src/services/branch.service.js";
import { devStaffTokenService } from "../../src/services/dev-staff-token.service.js";
import { organizationProvisioningService } from "../../src/services/organization-provisioning.service.js";
import { platformBootstrapService } from "../../src/services/platform-bootstrap.service.js";
import { call, withServer } from "../helpers/http.js";

/**
 * Phase 2 authorization matrix against a real, disposable PostgreSQL (TEST_DATABASE=1): the real app, real
 * signed staff tokens and the real permission engine, with the fixture built through the provisioning service.
 * Test files run one at a time (--test-concurrency=1), so this never shares events_test with database.test.ts.
 */
const enabled = process.env.TEST_DATABASE === "1";
const skip = enabled ? false : "set TEST_DATABASE=1 with a disposable Postgres to run";

const PEOPLE = {
  SELAM_OWNER: "c1111111-1111-4111-8111-111111111111",
  SELAM_VIEWER: "c2222222-2222-4222-8222-222222222222",
  SELAM_ADDIS: "c3333333-3333-4333-8333-333333333333",
  HORN_OWNER: "c4444444-4444-4444-8444-444444444444",
  SUPER: "c5555555-5555-4555-8555-555555555555",
  NO_ROLE: "c6666666-6666-4666-8666-666666666666",
} as const;
type Person = keyof typeof PEOPLE;

const app = createApp();
const NO_PROFILE = { mobile: null, firstname: null, middlename: null, lastname: null };
const tokens = new Map<Person, string>();
const fixture = { selamId: "", selamMainBranchId: "", selamAddisBranchId: "", hornId: "" };

/** A real staff token for the person's one active assignment, as login would issue it. */
async function tokenFor(userId: string): Promise<string> {
  const [assignment, ...others] = await userRoleRepository.listActiveAssignmentsByUser(userId);
  assert.ok(assignment && others.length === 0, `expected exactly one active assignment for ${userId}`);
  return authTokenService.signAppStaffToken({ userId, assignment, profile: NO_PROFILE }).token;
}

async function as(person: Person, method: string, path: string, body?: unknown) {
  const token = tokens.get(person);
  assert.ok(token, `no token for ${person}`);
  return withServer(app, (baseUrl) => call(baseUrl, method, path, body === undefined ? { token } : { token, body }));
}

const branchesOf = (organizationId: string) => `/v1/organizations/${organizationId}/branches`;

async function addOverride(person: Person, values: { can_create: boolean }): Promise<void> {
  const branchesModule = await moduleRepository.findActivePermissionByCode("BRANCHES");
  const [assignment] = await userRoleRepository.listActiveAssignmentsByUser(PEOPLE[person]);
  assert.ok(branchesModule && assignment);
  await UserModuleAccess.create({
    user_role_id: assignment.id,
    module_id: branchesModule.id,
    can_view: null,
    can_create: values.can_create,
    can_update: null,
    can_delete: null,
    can_import: null,
    can_export: null,
    can_notify: null,
    created_by: null,
    updated_by: null,
  });
}

before(async () => {
  if (!enabled) return;
  await migrator.down({ to: 0 });
  await migrator.up();

  const selam = await organizationProvisioningService.provisionOrganizer(
    { name: "Selam Events", ownerUserId: PEOPLE.SELAM_OWNER },
    null,
    { apply: true },
  );
  assert.ok(selam.organizationId && selam.defaultBranchId);
  const addis = await branchService.createBranch(selam.organizationId, { code: "ADDIS", name: "Addis Office", description: undefined }, null);
  Object.assign(fixture, { selamId: selam.organizationId, selamMainBranchId: selam.defaultBranchId, selamAddisBranchId: addis.id });

  await organizationProvisioningService.assignStaff({ organizationId: fixture.selamId, userId: PEOPLE.SELAM_VIEWER, roleCode: "VIEWER" }, null, { apply: true });
  await organizationProvisioningService.assignStaff(
    { organizationId: fixture.selamId, userId: PEOPLE.SELAM_ADDIS, roleCode: "VIEWER", branchCode: "ADDIS" },
    null,
    { apply: true },
  );

  const horn = await organizationProvisioningService.provisionOrganizer(
    { name: "Horn Health Alliance", ownerUserId: PEOPLE.HORN_OWNER },
    null,
    { apply: true },
  );
  assert.ok(horn.organizationId);
  fixture.hornId = horn.organizationId;

  await platformBootstrapService.assignSuperAdmin(PEOPLE.SUPER, { apply: true });

  for (const person of ["SELAM_OWNER", "SELAM_VIEWER", "SELAM_ADDIS", "HORN_OWNER", "SUPER"] as const) {
    tokens.set(person, await tokenFor(PEOPLE[person]));
  }
});

after(async () => {
  if (enabled) {
    await sequelize.query('TRUNCATE "user_module_access", "user_role", "role_module_access", "branch", "organization" CASCADE');
    await migrator.down({ to: 0 });
  }
  await sequelize.close();
});

test("rows 1–2: an owner lists exactly their organization's branches and can create one", { skip }, async () => {
  const list = await as("SELAM_OWNER", "GET", branchesOf(fixture.selamId));
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.data.map((branch: { code: string }) => branch.code).sort(), ["ADDIS", "MAIN"]);

  const created = await as("SELAM_OWNER", "POST", branchesOf(fixture.selamId), { code: "BAHIR_DAR", name: "Bahir Dar Office" });
  assert.equal(created.status, 201);
});

test("rows 3–5: a viewer can read but cannot create or edit, and nothing is written", { skip }, async () => {
  assert.equal((await as("SELAM_VIEWER", "GET", branchesOf(fixture.selamId))).status, 200);

  const countBefore = await Branch.count({ where: { organization_id: fixture.selamId } });
  const create = await as("SELAM_VIEWER", "POST", branchesOf(fixture.selamId), { code: "GONDAR", name: "Gondar Office" });
  assert.equal(create.status, 403);
  assert.equal(create.body.error.code, "permission_denied");
  assert.equal(await Branch.count({ where: { organization_id: fixture.selamId } }), countBefore, "no branch was created");

  const edit = await as("SELAM_VIEWER", "PATCH", `${branchesOf(fixture.selamId)}/${fixture.selamMainBranchId}`, { name: "Renamed" });
  assert.equal(edit.status, 403);
});

test("rows 6–8: branch-scoped staff see only their branch, never the organization-wide list", { skip }, async () => {
  assert.equal((await as("SELAM_ADDIS", "GET", `${branchesOf(fixture.selamId)}/${fixture.selamAddisBranchId}`)).status, 200);
  assert.equal((await as("SELAM_ADDIS", "GET", `${branchesOf(fixture.selamId)}/${fixture.selamMainBranchId}`)).status, 403);
  assert.equal((await as("SELAM_ADDIS", "GET", branchesOf(fixture.selamId))).status, 403);
});

test("rows 9–11: an owner cannot reach another organization or platform administration", { skip }, async () => {
  assert.equal((await as("SELAM_OWNER", "GET", branchesOf(fixture.hornId))).status, 403);
  assert.equal((await as("SELAM_OWNER", "GET", `/v1/organizations/${fixture.hornId}`)).status, 403);
  assert.equal((await as("SELAM_OWNER", "POST", "/v1/organizations", { organization: { name: "Rogue Org" } })).status, 403);
});

test("rows 12–13: the platform Super Admin creates organizations and reads any tenant", { skip }, async () => {
  assert.equal((await as("SUPER", "POST", "/v1/organizations", { organization: { name: "Abay Expo" } })).status, 201);
  assert.equal((await as("SUPER", "GET", branchesOf(fixture.hornId))).status, 200);
});

test("row 14: a viewer's session shows view-only branches, Administration › Organizations and Branches, no Access Control", { skip }, async () => {
  const me = await as("SELAM_VIEWER", "GET", "/v1/auth/staff/me");
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.data.permissions.BRANCHES, {
    view: true,
    create: false,
    update: false,
    delete: false,
    import: false,
    export: false,
    notify: false,
  });
  const navigation: Array<{ code: string; children: Array<{ code: string }> }> = me.body.data.navigation;
  assert.deepEqual(navigation.find((node) => node.code === "ADMINISTRATION")?.children.map((child) => child.code), ["ORGANIZATIONS", "BRANCHES"]);
  assert.ok(!navigation.some((node) => node.code === "ACCESS_CONTROL"));
});

test("row 15: an owner's session shows branch view/create/update and Access Control › Roles, Staff Assignments", { skip }, async () => {
  const me = await as("SELAM_OWNER", "GET", "/v1/auth/staff/me");
  assert.equal(me.status, 200);
  const branches = me.body.data.permissions.BRANCHES;
  assert.deepEqual([branches.view, branches.create, branches.update, branches.delete], [true, true, true, false]);
  const navigation: Array<{ code: string; children: Array<{ code: string }> }> = me.body.data.navigation;
  assert.deepEqual(navigation.find((node) => node.code === "ACCESS_CONTROL")?.children.map((child) => child.code), ["ROLES", "USER_ROLES"]);
});

test("rows 16–17: an override allows a viewer to create; an override denies an owner (deny wins)", { skip }, async () => {
  await addOverride("SELAM_VIEWER", { can_create: true });
  assert.equal((await as("SELAM_VIEWER", "POST", branchesOf(fixture.selamId), { code: "GONDAR", name: "Gondar Office" })).status, 201);

  await addOverride("SELAM_OWNER", { can_create: false });
  assert.equal((await as("SELAM_OWNER", "POST", branchesOf(fixture.selamId), { code: "DIRE_DAWA", name: "Dire Dawa Office" })).status, 403);
});

test("row 18: one person, one organization; repeating an assignment is a no-op; no role means no token", { skip }, async () => {
  await assert.rejects(
    organizationProvisioningService.assignStaff({ organizationId: fixture.selamId, userId: PEOPLE.HORN_OWNER, roleCode: "VIEWER" }, null, {
      apply: true,
    }),
    ConflictError,
  );

  const again = await organizationProvisioningService.assignStaff(
    { organizationId: fixture.selamId, userId: PEOPLE.SELAM_VIEWER, roleCode: "VIEWER" },
    null,
    { apply: true },
  );
  assert.equal(again.action, "unchanged");

  await assert.rejects(
    devStaffTokenService.issueDevelopmentStaffToken({ userId: PEOPLE.NO_ROLE, environment: "development" }),
    StaffAssignmentNotFoundError,
  );
});
