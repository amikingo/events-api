import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../../src/app.js";
import { filesConfig } from "../../src/config/files.js";
import { sequelize } from "../../src/db.js";
import { ConflictError, InvalidBranchStateError, StaffAssignmentNotFoundError } from "../../src/errors/app-errors.js";
import { migrator } from "../../src/migrator.js";
import { AppEvent, Branch, CustomerAccount, Organization, StoredFile, UserModuleAccess } from "../../src/models/index.js";
import { eventRepository } from "../../src/repositories/event.repository.js";
import { moduleRepository } from "../../src/repositories/module.repository.js";
import { userRoleRepository } from "../../src/repositories/user-role.repository.js";
import { authTokenService } from "../../src/services/auth-token.service.js";
import { branchService } from "../../src/services/branch.service.js";
import { devStaffTokenService } from "../../src/services/dev-staff-token.service.js";
import { organizationProvisioningService } from "../../src/services/organization-provisioning.service.js";
import { platformBootstrapService } from "../../src/services/platform-bootstrap.service.js";
import { call, withServer, type TestResponse } from "../helpers/http.js";

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

// --- Phase 3c: the public catalog and event pages (no login) ----------------------------------------

const publicGet = (path: string) => withServer(app, (baseUrl) => call(baseUrl, "GET", path));

async function createAndPublish(person: Person, organizationId: string, body: Record<string, unknown>): Promise<{ id: string; slug: string }> {
  const created = await as(person, "POST", `/v1/organizations/${organizationId}/events`, body);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const published = await as(person, "PATCH", `/v1/organizations/${organizationId}/events/${created.body.data.id}/status`, { status: "PUBLISHED" });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  return created.body.data;
}

const publicFixture = { summitId: "", summitEndsAt: new Date("2027-06-01T14:00:00Z") };

test("rows 32–34: the catalog lists upcoming PUBLISHED + PUBLIC events with visitor fields; filters; closing sign-ups keeps an event listed", { skip }, async () => {
  const venues = await as("SELAM_OWNER", "GET", `/v1/organizations/${fixture.selamId}/venues`);
  const hall = venues.body.data.find((venue: { name: string }) => venue.name === "Millennium Hall");
  assert.ok(hall, "Millennium Hall was recorded in row 22");

  const summit = await createAndPublish("SELAM_OWNER", fixture.selamId, {
    name: "Annual Summit",
    starts_at: "2027-06-01T09:00:00+03:00",
    ends_at: publicFixture.summitEndsAt.toISOString(),
    visibility: "PUBLIC",
    category: "Conference",
    venue_id: hall.id,
  });
  publicFixture.summitId = summit.id;
  await createAndPublish("SELAM_OWNER", fixture.selamId, {
    name: "Partner Workshop",
    starts_at: "2027-07-01T09:00:00+03:00",
    ends_at: "2027-07-01T12:00:00+03:00",
  }); // UNLISTED by default
  await createAndPublish("SELAM_OWNER", fixture.selamId, {
    name: "Past Meetup",
    starts_at: "2026-01-10T15:00:00+03:00",
    ends_at: "2026-01-10T18:00:00+03:00",
    visibility: "PUBLIC",
  }); // already ended

  // Row 32: only the upcoming PUBLIC event is listed (not the unlisted one, the ended one, the closed forum or drafts).
  const catalog = await publicGet("/v1/public/events?organization=selam-events");
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.body.data.map((card: { name: string }) => card.name), ["Annual Summit"]);
  assert.equal(catalog.body.meta.count, 1, "the total count follows the same rules");
  const card = catalog.body.data[0];
  assert.deepEqual([card.slug, card.organization.slug, card.venue.name, card.category, card.cover, card.registration_open], [
    "annual-summit",
    "selam-events",
    "Millennium Hall",
    "Conference",
    null,
    true,
  ]);
  assert.ok(!("id" in card) && !("organization_id" in card) && !("customer_account_id" in card), "no internal ids");

  // Row 33: the category filter is exact and ignores case.
  assert.equal((await publicGet("/v1/public/events?organization=selam-events&category=conference")).body.meta.count, 1);
  assert.equal((await publicGet("/v1/public/events?organization=selam-events&category=conf")).body.meta.count, 0);

  // Row 34: stopping sign-ups early keeps the event in the catalog, with registration_open false.
  const closedSignUps = await as("SELAM_OWNER", "PATCH", `/v1/organizations/${fixture.selamId}/events/${summit.id}`, {
    registration_closes_at: "2026-11-01T00:00:00+03:00",
  });
  assert.equal(closedSignUps.status, 200);
  const after = await publicGet("/v1/public/events?organization=selam-events");
  assert.deepEqual(after.body.data.map((item: { name: string; registration_open: boolean }) => [item.name, item.registration_open]), [
    ["Annual Summit", false],
  ]);
});

test("rows 35–36: direct links open any event published at least once, by both slugs; drafts and never-published cancellations are 404", { skip }, async () => {
  // Row 35: unlisted, ended and closed events open by link; detail has the description and active ticket types.
  const unlisted = await publicGet("/v1/public/organizations/selam-events/events/partner-workshop");
  assert.equal(unlisted.status, 200);
  assert.deepEqual(unlisted.body.data.ticket_types, [{ code: "GA", name: "General Admission" }]);
  assert.ok("description" in unlisted.body.data);
  const ended = await publicGet("/v1/public/organizations/selam-events/events/past-meetup");
  assert.deepEqual([ended.status, ended.body.data.registration_open], [200, false]);
  const closedForum = await publicGet("/v1/public/organizations/selam-events/events/banking-forum");
  assert.deepEqual([closedForum.status, closedForum.body.data.display_status], [200, "CLOSED"]);
  const clients = await as("SELAM_OWNER", "GET", `/v1/organizations/${fixture.selamId}/customer-accounts`);
  const abcBank = clients.body.data.find((client: { name: string }) => client.name === "ABC Bank");
  assert.ok(!JSON.stringify(closedForum.body).includes(abcBank.id), "the commissioning client stays private");

  // Both cancellation cases: published then cancelled stays reachable (shows CANCELLED); cancelled as a draft is 404.
  const gala = await createAndPublish("SELAM_OWNER", fixture.selamId, {
    name: "Gala Night",
    starts_at: "2027-08-01T18:00:00+03:00",
    ends_at: "2027-08-01T23:00:00+03:00",
    visibility: "PUBLIC",
  });
  assert.equal((await as("SELAM_OWNER", "PATCH", `/v1/organizations/${fixture.selamId}/events/${gala.id}/status`, { status: "CANCELLED" })).status, 200);
  const cancelled = await publicGet("/v1/public/organizations/selam-events/events/gala-night");
  assert.deepEqual([cancelled.status, cancelled.body.data.display_status, cancelled.body.data.registration_open], [200, "CANCELLED", false]);
  assert.ok(!(await publicGet("/v1/public/events?organization=selam-events")).body.data.some((item: { slug: string }) => item.slug === "gala-night"));
  assert.equal((await publicGet("/v1/public/organizations/selam-events/events/banking-forum-2")).status, 404, "cancelled while still a draft");
  assert.equal((await publicGet("/v1/public/organizations/selam-events/events/london-roadshow")).status, 404, "a draft");

  // Row 36: two organizers may use the same event slug; each link resolves its own event.
  await createAndPublish("HORN_OWNER", fixture.hornId, {
    name: "Banking Forum",
    starts_at: "2027-09-01T09:00:00+03:00",
    ends_at: "2027-09-01T17:00:00+03:00",
    visibility: "PUBLIC",
  });
  const horn = await publicGet("/v1/public/organizations/horn-health-alliance/events/banking-forum");
  assert.deepEqual([horn.status, horn.body.data.organization.slug, horn.body.data.display_status], [200, "horn-health-alliance", "PUBLISHED"]);
  const selam = await publicGet("/v1/public/organizations/selam-events/events/banking-forum");
  assert.deepEqual([selam.body.data.organization.slug, selam.body.data.display_status], ["selam-events", "CLOSED"]);
  const hornCatalog = await publicGet("/v1/public/events?organization=horn-health-alliance");
  assert.deepEqual(hornCatalog.body.data.map((item: { name: string }) => item.name), ["Banking Forum"]);
});

test("row 37: an event leaves the catalog at its exact end time; an inactive organization disappears", { skip }, async () => {
  // The exact boundary, on the real database: listed 1 ms before ends_at, gone at ends_at (now < ends_at).
  const justBefore = await eventRepository.listPublicCatalog({
    now: new Date(publicFixture.summitEndsAt.getTime() - 1),
    organizationSlug: "selam-events",
    limit: 20,
    offset: 0,
  });
  assert.ok(justBefore.rows.some((row) => row.id === publicFixture.summitId));
  const atEnd = await eventRepository.listPublicCatalog({ now: publicFixture.summitEndsAt, organizationSlug: "selam-events", limit: 20, offset: 0 });
  assert.ok(!atEnd.rows.some((row) => row.id === publicFixture.summitId));

  // An inactive organization's events vanish from the catalog and their links answer 404.
  await Organization.update({ is_active: false }, { where: { id: fixture.hornId } });
  assert.equal((await publicGet("/v1/public/organizations/horn-health-alliance/events/banking-forum")).status, 404);
  assert.equal((await publicGet("/v1/public/events?organization=horn-health-alliance")).body.meta.count, 0);
});

// --- Phase 3d: event covers (local disk under FILES_DIR, a temporary folder in tests) -------------------

const PNG_COVER = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("integration cover")]);
const JPEG_COVER = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("integration cover, second")]);
const coversFolder = join(filesConfig.rootDir, "events", "covers");
const coverFixture = { firstUrl: "", firstKey: "" };

function coverForm(bytes: Buffer, name: string): FormData {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)]), name);
  return form;
}

async function uploadAs(person: Person, path: string, form: FormData): Promise<TestResponse> {
  const token = tokens.get(person);
  assert.ok(token, `no token for ${person}`);
  return withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}${path}`, { method: "PUT", headers: { Authorization: `Bearer ${token}` }, body: form });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  });
}

const summitCoverPath = () => `/v1/organizations/${fixture.selamId}/events/${publicFixture.summitId}/cover`;
const coversOfSummit = () => StoredFile.findAll({ where: { entity_id: publicFixture.summitId }, order: [["created_at", "ASC"]], raw: true });
const filesOnDisk = () => (existsSync(coversFolder) ? readdirSync(coversFolder).length : 0);

test("row 38: an owner uploads a cover; it is recorded as EVENT_COVER, served publicly, and shown on staff and public pages", { skip }, async () => {
  const uploaded = await uploadAs("SELAM_OWNER", summitCoverPath(), coverForm(PNG_COVER, "summit.png"));
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
  const url: string = uploaded.body.data.cover.url;
  assert.match(url, /^\/assets\/uploads\/events\/covers\/[0-9a-f-]{36}\.png$/);

  const [file, ...others] = await coversOfSummit();
  assert.ok(file && others.length === 0, "one file row");
  assert.deepEqual(
    [file.organization_id, file.purpose, file.entity_type, file.storage_provider, file.content_type, file.size_bytes, file.original_name, file.uploaded_by],
    [fixture.selamId, "EVENT_COVER", "EVENT", "local", "image/png", PNG_COVER.length, "summit.png", PEOPLE.SELAM_OWNER],
  );
  assert.equal(`/assets/uploads/${file.storage_key}`, url);
  assert.equal(uploaded.body.data.cover_file_id, file.id);
  Object.assign(coverFixture, { firstUrl: url, firstKey: file.storage_key });

  // Served without login, cross-origin, byte for byte.
  const served = await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}${url}`);
    return { status: response.status, corp: response.headers.get("cross-origin-resource-policy"), bytes: Buffer.from(await response.arrayBuffer()) };
  });
  assert.deepEqual([served.status, served.corp], [200, "cross-origin"]);
  assert.deepEqual(served.bytes, PNG_COVER);

  // Staff read, public card and public page all carry the same path.
  const staff = await as("SELAM_OWNER", "GET", `/v1/organizations/${fixture.selamId}/events/${publicFixture.summitId}`);
  assert.deepEqual(staff.body.data.cover, { url });
  const catalog = await publicGet("/v1/public/events?organization=selam-events");
  assert.deepEqual(catalog.body.data.find((card: { slug: string }) => card.slug === "annual-summit")?.cover, { url });
  assert.deepEqual((await publicGet("/v1/public/organizations/selam-events/events/annual-summit")).body.data.cover, { url });
});

test("row 39: refused uploads write nothing: viewers, branch-limited staff, another tenant, a non-image, a CLOSED event", { skip }, async () => {
  const diskBefore = filesOnDisk();
  const rowsBefore = await StoredFile.count();

  assert.equal((await uploadAs("SELAM_VIEWER", summitCoverPath(), coverForm(PNG_COVER, "a.png"))).status, 403);
  assert.equal((await uploadAs("SELAM_ADDIS", summitCoverPath(), coverForm(PNG_COVER, "a.png"))).status, 403);
  assert.equal((await as("SELAM_VIEWER", "DELETE", summitCoverPath())).status, 403);
  const otherTenant = `/v1/organizations/${fixture.hornId}/events/${fixture.forumId}/cover`;
  assert.equal((await uploadAs("SELAM_OWNER", otherTenant, coverForm(PNG_COVER, "a.png"))).status, 403);

  const notImage = await uploadAs("SELAM_OWNER", summitCoverPath(), coverForm(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "cover.png"));
  assert.deepEqual([notImage.status, notImage.body.error.code], [415, "unsupported_file_type"]);
  const closedForum = `/v1/organizations/${fixture.selamId}/events/${fixture.forumId}/cover`;
  const closed = await uploadAs("SELAM_OWNER", closedForum, coverForm(PNG_COVER, "a.png"));
  assert.deepEqual([closed.status, closed.body.error.code], [409, "invalid_event_state"]);

  assert.equal(filesOnDisk(), diskBefore, "no file written");
  assert.equal(await StoredFile.count(), rowsBefore, "no file row recorded");
  const staff = await as("SELAM_OWNER", "GET", `/v1/organizations/${fixture.selamId}/events/${publicFixture.summitId}`);
  assert.deepEqual(staff.body.data.cover, { url: coverFixture.firstUrl }, "the cover is unchanged");
});

test("row 40: a new upload replaces the cover; removing it clears staff and public pages; old files stay for a later clean-up", { skip }, async () => {
  const replaced = await uploadAs("SELAM_OWNER", summitCoverPath(), coverForm(JPEG_COVER, "summit-2.jpg"));
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  const secondUrl: string = replaced.body.data.cover.url;
  assert.match(secondUrl, /\.jpg$/);
  assert.notEqual(secondUrl, coverFixture.firstUrl);
  assert.equal((await coversOfSummit()).length, 2);
  assert.ok(existsSync(join(filesConfig.rootDir, coverFixture.firstKey)), "the replaced file is still on disk");

  const removed = await as("SELAM_OWNER", "DELETE", summitCoverPath());
  assert.deepEqual([removed.status, removed.body.data.cover, removed.body.data.cover_file_id], [200, null, null]);
  assert.equal((await publicGet("/v1/public/organizations/selam-events/events/annual-summit")).body.data.cover, null);
  const catalog = await publicGet("/v1/public/events?organization=selam-events");
  assert.equal(catalog.body.data.find((card: { slug: string }) => card.slug === "annual-summit")?.cover, null);

  assert.equal((await coversOfSummit()).length, 2, "file rows are kept");
  assert.ok(existsSync(join(filesConfig.rootDir, coverFixture.firstKey)));
  assert.ok(existsSync(join(filesConfig.rootDir, secondUrl.replace("/assets/uploads/", ""))));
});
