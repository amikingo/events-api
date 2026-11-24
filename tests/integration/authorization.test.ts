import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createApp } from "../../src/app.js";
import { sequelize } from "../../src/db.js";
import { ConflictError, InvalidBranchStateError, StaffAssignmentNotFoundError } from "../../src/errors/app-errors.js";
import { migrator } from "../../src/migrator.js";
import { AppEvent, Branch, CustomerAccount, UserModuleAccess } from "../../src/models/index.js";
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
const fixture = { selamId: "", selamMainBranchId: "", selamAddisBranchId: "", hornId: "", forumId: "", twinId: "" };

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

  // Selam uses branches; Horn (below) does not, so it keeps only its hidden MAIN branch.
  const selam = await organizationProvisioningService.provisionOrganizer(
    { name: "Selam Events", ownerUserId: PEOPLE.SELAM_OWNER, hasBranches: true },
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

const administrationItems = (navigation: Array<{ code: string; children: Array<{ code: string }> }>) =>
  navigation.find((node) => node.code === "ADMINISTRATION")?.children.map((child) => child.code);

test("rows 19–21: an organization without branches hides them, refuses branch-limited staff, and turns them on when it adds one", { skip }, async () => {
  // Row 19: Horn has only its hidden MAIN branch.
  const before = await as("HORN_OWNER", "GET", "/v1/auth/staff/me");
  assert.equal(before.status, 200);
  assert.equal(before.body.data.assignment.organization.has_branches, false);
  assert.deepEqual(administrationItems(before.body.data.navigation), ["ORGANIZATIONS"]);

  // Row 20: no branch-limited staff in an organization without branches.
  await assert.rejects(
    organizationProvisioningService.assignStaff(
      { organizationId: fixture.hornId, userId: "c7777777-7777-4777-8777-777777777777", roleCode: "VIEWER", branchCode: "MAIN" },
      null,
      { apply: true },
    ),
    InvalidBranchStateError,
  );

  // Row 21: adding a branch turns branches on.
  const created = await as("HORN_OWNER", "POST", branchesOf(fixture.hornId), { code: "HARAR", name: "Harar Office" });
  assert.equal(created.status, 201);
  const after = await as("HORN_OWNER", "GET", "/v1/auth/staff/me");
  assert.equal(after.body.data.assignment.organization.has_branches, true);
  assert.deepEqual(administrationItems(after.body.data.navigation), ["ORGANIZATIONS", "BRANCHES"]);
});

test("rows 22–25: clients and venues are tenant-scoped, read-only for viewers, and appear under Event Management", { skip }, async () => {
  const clients = `/v1/organizations/${fixture.selamId}/customer-accounts`;
  const venues = `/v1/organizations/${fixture.selamId}/venues`;

  // Row 22: the owner records a client and a venue.
  const client = await as("SELAM_OWNER", "POST", clients, { name: "ABC Bank", type: "Corporate", primary_contact_phone: "0911223344" });
  assert.equal(client.status, 201);
  assert.equal(client.body.data.primary_contact_phone, "+251911223344");
  const venue = await as("SELAM_OWNER", "POST", venues, { name: "Millennium Hall", city: "Addis Ababa", country: "et", capacity: 2000 });
  assert.equal(venue.status, 201);
  assert.equal(venue.body.data.country, "ET");
  // The database itself refuses an individual client with a sector type (backstop behind the service).
  await assert.rejects(
    CustomerAccount.create({
      organization_id: fixture.selamId,
      name: "Hana Bekele",
      kind: "INDIVIDUAL",
      type: "NGO",
      primary_contact_name: null,
      primary_contact_email: null,
      primary_contact_phone: null,
      created_by: null,
      updated_by: null,
    }),
  );

  // Row 23: a viewer reads clients and venues but cannot create them.
  const list = await as("SELAM_VIEWER", "GET", clients);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.data.map((row: { name: string }) => row.name), ["ABC Bank"]);
  assert.equal((await as("SELAM_VIEWER", "GET", venues)).status, 200);
  assert.equal((await as("SELAM_VIEWER", "POST", clients, { name: "Rogue Client" })).status, 403);

  // Row 24: another organization never reaches them, not even with the id.
  assert.equal((await as("HORN_OWNER", "GET", clients)).status, 403);
  assert.equal((await as("HORN_OWNER", "GET", `/v1/organizations/${fixture.hornId}/venues/${venue.body.data.id}`)).status, 404);

  // Row 25: the menu shows Event Management › Events, Clients.
  const me = await as("SELAM_VIEWER", "GET", "/v1/auth/staff/me");
  const navigation: Array<{ code: string; children: Array<{ code: string }> }> = me.body.data.navigation;
  assert.deepEqual(navigation.find((node) => node.code === "EVENT_MANAGEMENT")?.children.map((child) => child.code), ["EVENTS", "CUSTOMERS"]);
});

// --- Phase 3b: events and ticket types -----------------------------------------------------------

test("rows 26–28: a new event is a DRAFT with General Admission; publishing freezes the slug; closing registration keeps it published and public", { skip }, async () => {
  const events = `/v1/organizations/${fixture.selamId}/events`;

  // Row 26: DRAFT, UNLISTED, organization-wide (even though MAIN exists), the organization's timezone, GA, a slug.
  const created = await as("SELAM_OWNER", "POST", events, { name: "Banking Forum" });
  assert.equal(created.status, 201);
  const forum = created.body.data;
  assert.deepEqual(
    [forum.status, forum.visibility, forum.branch_id, forum.timezone, forum.slug, forum.display_status],
    ["DRAFT", "UNLISTED", null, "Africa/Addis_Ababa", "banking-forum", "DRAFT"],
  );
  const tickets = await as("SELAM_OWNER", "GET", `${events}/${forum.id}/ticket-types`);
  assert.deepEqual(
    tickets.body.data.map((ticket: { code: string; name: string; capacity: number | null }) => [ticket.code, ticket.name, ticket.capacity]),
    [["GA", "General Admission", null]],
  );
  const twin = await as("SELAM_OWNER", "POST", events, { name: "Banking Forum" });
  assert.equal(twin.body.data.slug, "banking-forum-2");
  fixture.forumId = forum.id;
  fixture.twinId = twin.body.data.id;

  // Row 27: publishing needs dates; once published the slug is frozen but the name can change.
  const notReady = await as("SELAM_OWNER", "PATCH", `${events}/${forum.id}/status`, { status: "PUBLISHED" });
  assert.equal(notReady.status, 409);
  assert.equal(notReady.body.error.code, "event_not_publishable");
  const clients = await as("SELAM_OWNER", "GET", `/v1/organizations/${fixture.selamId}/customer-accounts`);
  const abcBank = clients.body.data.find((client: { name: string }) => client.name === "ABC Bank");
  assert.ok(abcBank, "ABC Bank was recorded in row 22");
  const ready = await as("SELAM_OWNER", "PATCH", `${events}/${forum.id}`, {
    starts_at: "2027-03-12T09:00:00+03:00",
    ends_at: "2027-03-12T17:00:00+03:00",
    visibility: "PUBLIC",
    capacity: 500,
    customer_account_id: abcBank.id,
    category: "Conference",
  });
  assert.equal(ready.status, 200);
  const published = await as("SELAM_OWNER", "PATCH", `${events}/${forum.id}/status`, { status: "PUBLISHED" });
  assert.equal(published.status, 200);
  assert.equal(published.body.data.status, "PUBLISHED");
  assert.equal((await as("SELAM_OWNER", "PATCH", `${events}/${forum.id}`, { slug: "abc-forum" })).status, 409);
  const renamed = await as("SELAM_OWNER", "PATCH", `${events}/${forum.id}`, { name: "ABC Bank Banking Forum" });
  assert.equal(renamed.body.data.slug, "banking-forum", "the slug survives a rename");

  // Row 28: stopping sign-ups early leaves the event PUBLISHED and PUBLIC, so it stays visible (3c checks the catalog).
  const closedSignUps = await as("SELAM_OWNER", "PATCH", `${events}/${forum.id}`, { registration_closes_at: "2026-11-01T00:00:00+03:00" });
  assert.equal(closedSignUps.status, 200);
  assert.deepEqual([closedSignUps.body.data.status, closedSignUps.body.data.visibility], ["PUBLISHED", "PUBLIC"]);
});

test("rows 29–30: ticket limits fit within the event capacity; status changes follow the agreed transitions", { skip }, async () => {
  const forumPath = `/v1/organizations/${fixture.selamId}/events/${fixture.forumId}`;

  // Row 29: a ticket limit above the event capacity is refused; one within fits; the event can't then drop below it.
  assert.equal((await as("SELAM_OWNER", "POST", `${forumPath}/ticket-types`, { code: "vip", name: "VIP", capacity: 600 })).status, 400);
  const vip = await as("SELAM_OWNER", "POST", `${forumPath}/ticket-types`, { code: "vip", name: "VIP", capacity: 50 });
  assert.equal(vip.status, 201);
  assert.equal(vip.body.data.code, "VIP");
  assert.equal((await as("SELAM_OWNER", "PATCH", forumPath, { capacity: 40 })).status, 409);
  const tickets = (await as("SELAM_OWNER", "GET", `${forumPath}/ticket-types`)).body.data as Array<{ id: string; code: string }>;
  const generalAdmission = tickets.find((ticket) => ticket.code === "GA");
  assert.ok(generalAdmission);
  assert.equal((await as("SELAM_OWNER", "PATCH", `${forumPath}/ticket-types/${generalAdmission.id}/status`, { is_active: false })).status, 200);
  assert.equal(
    (await as("SELAM_OWNER", "PATCH", `${forumPath}/ticket-types/${vip.body.data.id}/status`, { is_active: false })).status,
    409,
    "a published event keeps at least one active ticket type",
  );

  // Row 30: DRAFT → CLOSED refused; DRAFT → CANCELLED, then no edits; PUBLISHED → CLOSED, then terminal.
  const twinPath = `/v1/organizations/${fixture.selamId}/events/${fixture.twinId}`;
  assert.equal((await as("SELAM_OWNER", "PATCH", `${twinPath}/status`, { status: "CLOSED" })).status, 409);
  assert.equal((await as("SELAM_OWNER", "PATCH", `${twinPath}/status`, { status: "CANCELLED" })).status, 200);
  assert.equal((await as("SELAM_OWNER", "PATCH", twinPath, { name: "Renamed" })).status, 409);
  assert.equal((await as("SELAM_OWNER", "PATCH", `${forumPath}/status`, { status: "CLOSED" })).status, 200);
  assert.equal((await as("SELAM_OWNER", "PATCH", `${forumPath}/status`, { status: "PUBLISHED" })).status, 409);
});

test("row 31: tenant safety, viewer read-only, explicit branch choice, and the organization's timezone", { skip }, async () => {
  const selamEvents = `/v1/organizations/${fixture.selamId}/events`;

  assert.equal((await as("SELAM_VIEWER", "GET", selamEvents)).status, 200);
  assert.equal((await as("SELAM_VIEWER", "POST", selamEvents, { name: "Rogue Event" })).status, 403);
  assert.equal((await as("HORN_OWNER", "GET", selamEvents)).status, 403);
  assert.equal((await as("HORN_OWNER", "GET", `/v1/organizations/${fixture.hornId}/events/${fixture.forumId}`)).status, 404);

  // Another organization's venue: refused by the API, and by PostgreSQL itself (composite foreign key).
  const hornVenue = await as("HORN_OWNER", "POST", `/v1/organizations/${fixture.hornId}/venues`, { name: "Harar Hall" });
  assert.equal(hornVenue.status, 201);
  assert.equal((await as("SELAM_OWNER", "POST", selamEvents, { name: "Workshop", venue_id: hornVenue.body.data.id })).status, 400);
  await assert.rejects(
    AppEvent.create({
      organization_id: fixture.selamId,
      venue_id: hornVenue.body.data.id,
      branch_id: null,
      customer_account_id: null,
      cover_file_id: null,
      name: "Rogue",
      slug: "rogue",
      description: null,
      starts_at: null,
      ends_at: null,
      timezone: "Africa/Addis_Ababa",
      capacity: null,
      registration_opens_at: null,
      registration_closes_at: null,
      category: null,
      created_by: null,
      updated_by: null,
    }),
  );

  // An active branch of the organization may be chosen explicitly; another organization's branch is refused.
  const workshop = await as("SELAM_OWNER", "POST", selamEvents, { name: "Workshop", branch_id: fixture.selamAddisBranchId });
  assert.equal(workshop.status, 201);
  assert.equal(workshop.body.data.branch_id, fixture.selamAddisBranchId);
  const hornBranches = await as("HORN_OWNER", "GET", `/v1/organizations/${fixture.hornId}/branches`);
  assert.equal((await as("SELAM_OWNER", "POST", selamEvents, { name: "Workshop", branch_id: hornBranches.body.data[0].id })).status, 400);

  // A new timezone for the organization leaves existing events alone; new events copy it.
  assert.equal((await as("SELAM_OWNER", "PATCH", `/v1/organizations/${fixture.selamId}`, { timezone: "Europe/London" })).status, 200);
  assert.equal((await as("SELAM_OWNER", "GET", `${selamEvents}/${workshop.body.data.id}`)).body.data.timezone, "Africa/Addis_Ababa");
  assert.equal((await as("SELAM_OWNER", "POST", selamEvents, { name: "London Roadshow" })).body.data.timezone, "Europe/London");
});
