import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, mock, test } from "node:test";
import { Op } from "sequelize";
import { createApp } from "../../src/app.js";
import { centralAuthClient } from "../../src/clients/central-auth.client.js";
import { filesConfig } from "../../src/config/files.js";
import { PRIVACY_NOTICE_VERSION } from "../../src/config/privacy.js";
import { sequelize } from "../../src/db.js";
import { CentralAuthUnavailableError, ConflictError, InvalidBranchStateError, StaffAssignmentNotFoundError } from "../../src/errors/app-errors.js";
import { publicRegistrationLimiter } from "../../src/middleware/rate-limit.js";
import { up as backfillDefaultRoles } from "../../src/migrations/20261127000100-backfill-default-roles.js";
import { up as grantGuestExportToOwners } from "../../src/migrations/20261129000000-grant-guest-export-to-owners.js";
import { migrator } from "../../src/migrator.js";
import {
  AppEvent,
  Branch,
  CustomerAccount,
  MessageOutbox,
  Organization,
  Person as PersonModel,
  Registration,
  Role,
  RoleModuleAccess,
  StoredFile,
  SubmissionKey,
  UserModuleAccess,
  UserRole,
} from "../../src/models/index.js";
import { eventRepository } from "../../src/repositories/event.repository.js";
import { moduleRepository } from "../../src/repositories/module.repository.js";
import { roleRepository } from "../../src/repositories/role.repository.js";
import { userRoleRepository } from "../../src/repositories/user-role.repository.js";
import { authTokenService } from "../../src/services/auth-token.service.js";
import { branchService } from "../../src/services/branch.service.js";
import { devStaffTokenService } from "../../src/services/dev-staff-token.service.js";
import { organizationProvisioningService } from "../../src/services/organization-provisioning.service.js";
import { outboxDeliveryService } from "../../src/services/outbox-delivery.service.js";
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

  // Row 25: the menu shows Event Management › Events, Clients (and Guests, since Phase 4a).
  const me = await as("SELAM_VIEWER", "GET", "/v1/auth/staff/me");
  const navigation: Array<{ code: string; children: Array<{ code: string }> }> = me.body.data.navigation;
  assert.deepEqual(navigation.find((node) => node.code === "EVENT_MANAGEMENT")?.children.map((child) => child.code), [
    "EVENTS",
    "CUSTOMERS",
    "REGISTRATIONS",
  ]);
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

// --- Phase 4a: guest profiles and staff registration ---------------------------------------------------

const guestFixture = { nightId: "", nightPath: "", gaId: "", hanaPersonId: "", hanaRegistrationId: "", hanaCode: "" };
const newGuest = (first_name: string, phone: string) => ({ person: { first_name, last_name: "Guest", phone } });

test("row 41: staff register a new guest: CONFIRMED, STAFF, the owner as registered_by, a code and one queued SMS", { skip }, async () => {
  const night = await createAndPublish("SELAM_OWNER", fixture.selamId, {
    name: "Guest Night",
    starts_at: "2027-10-01T18:00:00+03:00",
    ends_at: "2027-10-01T22:00:00+03:00",
    capacity: 2,
  });
  guestFixture.nightId = night.id;
  guestFixture.nightPath = `/v1/organizations/${fixture.selamId}/events/${night.id}/registrations`;
  const tickets = await as("SELAM_OWNER", "GET", `/v1/organizations/${fixture.selamId}/events/${night.id}/ticket-types`);
  guestFixture.gaId = tickets.body.data[0].id;

  const created = await as("SELAM_OWNER", "POST", guestFixture.nightPath, {
    person: { first_name: "Hana", last_name: "Bekele", phone: "0911 234 567", email: "hana@example.et" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const hana = created.body.data;
  assert.deepEqual(
    [hana.status, hana.source, hana.registered_by, hana.ticket_type.code, hana.person.phone, hana.privacy_notice],
    ["CONFIRMED", "STAFF", PEOPLE.SELAM_OWNER, "GA", "+251911234567", null],
  );
  assert.match(hana.code, /^[A-HJKMNP-Z2-9]{8}$/);
  Object.assign(guestFixture, { hanaPersonId: hana.person.id, hanaRegistrationId: hana.id, hanaCode: hana.code });

  const queued = await MessageOutbox.findAll({ where: { registration_id: hana.id }, raw: true });
  assert.deepEqual(
    queued.map((message) => [message.kind, message.channel, message.recipient, message.status, message.payload.code]),
    [["REGISTRATION_CONFIRMATION", "SMS", "+251911234567", "PENDING", hana.code]],
  );
});

test("row 42: several guests race for the last place at the same time; exactly one wins and one SMS is queued for it", { skip }, async () => {
  const racers = ["Abel", "Bethel", "Chala", "Dawit", "Eden"].map((name, index) => newGuest(name, `+25191100000${index}`));
  const results = await Promise.all(racers.map((body) => as("SELAM_OWNER", "POST", guestFixture.nightPath, body)));

  const statuses = results.map((response) => response.status).sort();
  assert.deepEqual(statuses, [201, 409, 409, 409, 409], JSON.stringify(results.map((response) => response.body)));
  for (const loser of results.filter((response) => response.status === 409)) {
    assert.deepEqual([loser.body.error.code, loser.body.error.details.scope], ["capacity_reached", "EVENT"]);
  }
  assert.equal(await Registration.count({ where: { event_id: guestFixture.nightId, status: "CONFIRMED" } }), 2);
  const registrationIds = (await Registration.findAll({ where: { event_id: guestFixture.nightId }, attributes: ["id"], raw: true })).map((row) => row.id);
  assert.equal(registrationIds.length, 2, "the losers left no registration behind");
  assert.equal(await MessageOutbox.count({ where: { registration_id: registrationIds } }), 2, "one SMS per place taken");
  assert.equal(await PersonModel.count({ where: { organization_id: fixture.selamId, last_name: "Guest" } }), 1, "the losers' new profiles were rolled back too");

  const summary = await as("SELAM_OWNER", "GET", `${guestFixture.nightPath}/summary`);
  assert.deepEqual([summary.body.data.capacity, summary.body.data.confirmed, summary.body.data.remaining], [2, 2, 0]);
});

test("row 43: cancelling frees the place; the cancelled guest comes back on the same row and code once there is room", { skip }, async () => {
  const hanaStatus = `${guestFixture.nightPath}/${guestFixture.hanaRegistrationId}/status`;
  const cancelled = await as("SELAM_OWNER", "PATCH", hanaStatus, { status: "CANCELLED" });
  assert.deepEqual([cancelled.status, cancelled.body.data.status], [200, "CANCELLED"]);
  assert.ok(cancelled.body.data.cancelled_at);

  const newcomer = await as("SELAM_OWNER", "POST", guestFixture.nightPath, newGuest("Fikir", "+251911000099"));
  assert.equal(newcomer.status, 201, "the freed place is taken");

  const whileFull = await as("SELAM_OWNER", "POST", guestFixture.nightPath, { person_id: guestFixture.hanaPersonId });
  assert.deepEqual([whileFull.status, whileFull.body.error.code], [409, "capacity_reached"]);

  assert.equal((await as("SELAM_OWNER", "PATCH", `${guestFixture.nightPath}/${newcomer.body.data.id}/status`, { status: "CANCELLED" })).status, 200);
  const back = await as("SELAM_OWNER", "POST", guestFixture.nightPath, { person_id: guestFixture.hanaPersonId });
  assert.deepEqual([back.status, back.body.message], [201, "Registration reactivated"]);
  assert.deepEqual([back.body.data.id, back.body.data.code, back.body.data.status, back.body.data.cancelled_at], [
    guestFixture.hanaRegistrationId,
    guestFixture.hanaCode,
    "CONFIRMED",
    null,
  ]);
  const again = await as("SELAM_OWNER", "POST", guestFixture.nightPath, { person_id: guestFixture.hanaPersonId });
  assert.deepEqual([again.status, again.body.message], [200, "Guest is already registered"], "a repeat takes no second place");
  assert.equal(await Registration.count({ where: { event_id: guestFixture.nightId, person_id: guestFixture.hanaPersonId } }), 1, "one row per guest per event");
});

test("row 44: drafts, closed sign-ups, inactive or foreign ticket types and another organization's guest are refused", { skip }, async () => {
  const selamEvents = `/v1/organizations/${fixture.selamId}/events`;
  const draft = await as("SELAM_OWNER", "POST", selamEvents, { name: "Unpublished Mixer" });
  const toDraft = await as("SELAM_OWNER", "POST", `${selamEvents}/${draft.body.data.id}/registrations`, { person_id: guestFixture.hanaPersonId });
  assert.deepEqual([toDraft.status, toDraft.body.error.code, toDraft.body.error.details.reason], [409, "registration_closed", "NOT_PUBLISHED"]);

  // The Annual Summit stopped sign-ups early in row 34.
  const summit = await as("SELAM_OWNER", "POST", `${selamEvents}/${publicFixture.summitId}/registrations`, { person_id: guestFixture.hanaPersonId });
  assert.deepEqual([summit.status, summit.body.error.details.reason], [409, "CLOSED"]);

  const vip = await as("SELAM_OWNER", "POST", `${selamEvents}/${guestFixture.nightId}/ticket-types`, { code: "VIP", name: "VIP" });
  await as("SELAM_OWNER", "PATCH", `${selamEvents}/${guestFixture.nightId}/ticket-types/${vip.body.data.id}/status`, { is_active: false });
  const inactive = await as("SELAM_OWNER", "POST", guestFixture.nightPath, { ...newGuest("Gelila", "+251911000098"), ticket_type_id: vip.body.data.id });
  assert.deepEqual([inactive.status, inactive.body.error.code], [409, "ticket_type_inactive"]);

  const summitTickets = await as("SELAM_OWNER", "GET", `${selamEvents}/${publicFixture.summitId}/ticket-types`);
  const foreignTicket = await as("SELAM_OWNER", "POST", guestFixture.nightPath, {
    ...newGuest("Hiwot", "+251911000097"),
    ticket_type_id: summitTickets.body.data[0].id,
  });
  assert.equal(foreignTicket.status, 404, "another event's ticket type is not found within this event");

  const hornGuest = await PersonModel.create({
    organization_id: fixture.hornId,
    first_name: "Abel",
    last_name: null,
    email: null,
    phone: null,
    affiliation_name: null,
    country: null,
    user_id: null,
    created_by: null,
    updated_by: null,
  });
  assert.equal((await as("SELAM_OWNER", "POST", guestFixture.nightPath, { person_id: hornGuest.id })).status, 404, "another organization's guest");

  // PostgreSQL itself rejects both shortcuts: another event's ticket type and another organization's guest. The
  // walk-in has no registration yet, so the one-row-per-guest unique key can't refuse the insert first.
  const walkIn = await PersonModel.create({
    organization_id: fixture.selamId,
    first_name: "Walk-in",
    last_name: null,
    email: null,
    phone: null,
    affiliation_name: null,
    country: null,
    user_id: null,
    created_by: null,
    updated_by: null,
  });
  const direct = {
    organization_id: fixture.selamId,
    event_id: guestFixture.nightId,
    status: "CONFIRMED" as const,
    source: "STAFF" as const,
    registered_by: PEOPLE.SELAM_OWNER,
    registered_at: new Date(),
    cancelled_at: null,
    code: "ABCDEFGH",
    privacy_notice_version: null,
    privacy_notice_shown_at: null,
    consent_purpose: null,
    consent_version: null,
    consented_at: null,
    created_by: null,
    updated_by: null,
  };
  const isForeignKeyError = (error: unknown) => error instanceof Error && error.name === "SequelizeForeignKeyConstraintError";
  await assert.rejects(
    Registration.create({ ...direct, person_id: walkIn.id, ticket_type_id: summitTickets.body.data[0].id }),
    isForeignKeyError,
  );
  await assert.rejects(Registration.create({ ...direct, person_id: hornGuest.id, ticket_type_id: guestFixture.gaId }), isForeignKeyError);
});

test("row 45: a viewer reads the guest list but can't register or cancel; branch-limited staff and another tenant get 403", { skip }, async () => {
  const list = await as("SELAM_VIEWER", "GET", `${guestFixture.nightPath}?status=CONFIRMED`);
  assert.equal(list.status, 200);
  assert.equal(list.body.meta.count, 2, "Hana and the winner of the race");
  assert.ok(list.body.data.some((row: { person: { first_name: string } }) => row.person.first_name === "Hana"));
  assert.equal((await as("SELAM_VIEWER", "GET", `${guestFixture.nightPath}?q=0911234567`)).body.data[0].person.first_name, "Hana", "search by local mobile");
  assert.equal((await as("SELAM_VIEWER", "GET", `/v1/organizations/${fixture.selamId}/persons/${guestFixture.hanaPersonId}`)).body.data.registrations.length, 1);

  assert.equal((await as("SELAM_VIEWER", "POST", guestFixture.nightPath, newGuest("Iman", "+251911000096"))).status, 403);
  assert.equal((await as("SELAM_VIEWER", "PATCH", `${guestFixture.nightPath}/${guestFixture.hanaRegistrationId}/status`, { status: "CANCELLED" })).status, 403);
  assert.equal((await as("SELAM_ADDIS", "GET", guestFixture.nightPath)).status, 403);
  assert.equal((await as("HORN_OWNER", "GET", guestFixture.nightPath)).status, 403);
});

test("row 46: the event's or a ticket type's capacity can't drop below its confirmed registrations", { skip }, async () => {
  const eventPath = `/v1/organizations/${fixture.selamId}/events/${guestFixture.nightId}`;
  const lower = await as("SELAM_OWNER", "PATCH", eventPath, { capacity: 1 });
  assert.deepEqual([lower.status, lower.body.error.code, lower.body.error.details.confirmed], [409, "capacity_below_registrations", 2]);

  const lowerTicket = await as("SELAM_OWNER", "PATCH", `${eventPath}/ticket-types/${guestFixture.gaId}`, { capacity: 1 });
  assert.deepEqual([lowerTicket.status, lowerTicket.body.error.code], [409, "capacity_below_registrations"]);

  assert.equal((await as("SELAM_OWNER", "PATCH", eventPath, { capacity: 3 })).status, 200, "raising it is fine");
});

// --- Phase 4b: public registration (no login) -----------------------------------------------------------

const workshopForm = (first_name: string, phone: string) => ({ first_name, last_name: "Visitor", phone, privacy_notice_version: PRIVACY_NOTICE_VERSION });
const workshopRegistrations = "/v1/public/organizations/selam-events/events/partner-workshop/registrations";

/** A POST with an Idempotency-Key, as a visitor (no token) or as a staff member. */
async function postWithKey(path: string, body: unknown, key: string, person?: Person): Promise<TestResponse> {
  const token = person ? tokens.get(person) : undefined;
  return withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  });
}

/** These rows send more public submissions than the 10-a-minute limit allows one address (proven separately). */
const resetPublicLimit = () => publicRegistrationLimiter.resetKey("127.0.0.1");

const workshopId = async () => {
  const workshop = await AppEvent.findOne({ where: { organization_id: fixture.selamId, slug: "partner-workshop" }, attributes: ["id"], raw: true });
  assert.ok(workshop);
  return workshop.id;
};

test("row 47: a retried submission returns the original registration with one confirmation in total, even when sent twice at once", { skip }, async () => {
  resetPublicLimit();
  const eventId = await workshopId();

  // Twice in a row: 201, then 200 with the same code.
  const key = randomUUID();
  const first = await postWithKey(workshopRegistrations, workshopForm("Liya", "0912000001"), key);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const again = await postWithKey(workshopRegistrations, workshopForm("Liya", "0912000001"), key);
  assert.deepEqual([again.status, again.body.data.code], [200, first.body.data.code]);
  const liya = await Registration.findAll({ where: { event_id: eventId, code: first.body.data.code }, attributes: ["id"], raw: true });
  assert.equal(liya.length, 1);
  assert.equal(await MessageOutbox.count({ where: { registration_id: liya.map((row) => row.id) } }), 1, "one confirmation in total");
  assert.equal(await PersonModel.count({ where: { organization_id: fixture.selamId, first_name: "Liya" } }), 1);

  // Twice at the same moment with one new key: one registration, one confirmation.
  const together = randomUUID();
  const [a, b] = await Promise.all([
    postWithKey(workshopRegistrations, workshopForm("Meron", "0912000002"), together),
    postWithKey(workshopRegistrations, workshopForm("Meron", "0912000002"), together),
  ]);
  assert.deepEqual([a?.status, b?.status].sort(), [200, 201]);
  assert.equal(a?.body.data.code, b?.body.data.code);
  const meron = await Registration.findAll({ where: { event_id: eventId, code: a?.body.data.code }, attributes: ["id"], raw: true });
  assert.equal(await MessageOutbox.count({ where: { registration_id: meron.map((row) => row.id) } }), 1);
  assert.equal(await PersonModel.count({ where: { organization_id: fixture.selamId, first_name: "Meron" } }), 1);

  // The same key with a changed form is refused.
  const reused = await postWithKey(workshopRegistrations, workshopForm("Liyu", "0912000001"), key);
  assert.deepEqual([reused.status, reused.body.error.code], [409, "idempotency_key_reused"]);

  // Staff entry with a key replays the same way.
  const staffPath = `/v1/organizations/${fixture.selamId}/events/${eventId}/registrations`;
  const staffKey = randomUUID();
  const staffBody = { person: { first_name: "Nahom", phone: "+251912000003" } };
  const created = await postWithKey(staffPath, staffBody, staffKey, "SELAM_OWNER");
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const repeated = await postWithKey(staffPath, staffBody, staffKey, "SELAM_OWNER");
  assert.deepEqual([repeated.status, repeated.body.message, repeated.body.data.id], [200, "Same request already processed", created.body.data.id]);
  assert.equal(await PersonModel.count({ where: { organization_id: fixture.selamId, first_name: "Nahom" } }), 1, "no second profile");
});

test("row 48: two separate submissions with the same phone create two profiles and two registrations", { skip }, async () => {
  resetPublicLimit();
  const first = await postWithKey(workshopRegistrations, workshopForm("Selam", "0912000004"), randomUUID());
  const second = await postWithKey(workshopRegistrations, workshopForm("Selam", "0912000004"), randomUUID());
  assert.deepEqual([first.status, second.status], [201, 201]);
  assert.notEqual(first.body.data.code, second.body.data.code);
  assert.equal(await PersonModel.count({ where: { organization_id: fixture.selamId, phone: "+251912000004" } }), 2, "a shared phone never links profiles");
});

test("row 49: an unlisted event registers by link with privacy evidence; drafts, inactive organizations and outdated notices write nothing", { skip }, async () => {
  resetPublicLimit();
  const eventId = await workshopId();
  const registered = await postWithKey(workshopRegistrations, workshopForm("Tigist", "0912000005"), randomUUID());
  assert.equal(registered.status, 201);
  assert.deepEqual(Object.keys(registered.body.data).sort(), ["code", "event", "guest", "organization", "registered_at", "status", "ticket_type"]);
  const row = await Registration.findOne({ where: { event_id: eventId, code: registered.body.data.code }, raw: true });
  assert.ok(row);
  assert.deepEqual(
    [row.source, row.registered_by, row.privacy_notice_version, row.privacy_notice_shown_at instanceof Date, row.consent_purpose],
    ["PUBLIC", null, PRIVACY_NOTICE_VERSION, true, null],
  );
  const staffView = await as("SELAM_OWNER", "GET", `/v1/organizations/${fixture.selamId}/events/${eventId}/registrations/${row.id}`);
  assert.equal(staffView.body.data.privacy_notice.version, PRIVACY_NOTICE_VERSION, "staff see the evidence");

  const people = await PersonModel.count();
  const keys = await SubmissionKey.count();
  const draft = await postWithKey("/v1/public/organizations/selam-events/events/london-roadshow/registrations", workshopForm("Yared", "0912000006"), randomUUID());
  assert.equal(draft.status, 404, "a draft");
  const inactive = await postWithKey("/v1/public/organizations/horn-health-alliance/events/banking-forum/registrations", workshopForm("Yared", "0912000006"), randomUUID());
  assert.equal(inactive.status, 404, "an inactive organization");
  const outdated = await postWithKey(workshopRegistrations, { ...workshopForm("Yared", "0912000006"), privacy_notice_version: "2020-01-01" }, randomUUID());
  assert.deepEqual([outdated.status, outdated.body.error.code, outdated.body.error.details.current], [409, "privacy_notice_outdated", PRIVACY_NOTICE_VERSION]);
  const closedSignUps = await postWithKey("/v1/public/organizations/selam-events/events/annual-summit/registrations", workshopForm("Yared", "0912000006"), randomUUID());
  assert.deepEqual([closedSignUps.status, closedSignUps.body.error.details.reason], [409, "CLOSED"]);
  assert.deepEqual([await PersonModel.count(), await SubmissionKey.count()], [people, keys], "nothing written for a refusal");
});

// --- Phase 4c: sending confirmations (log sender in tests: nothing leaves the machine) -------------------

test("row 50: the worker sends every due confirmation exactly once, leaves leased ones alone, and staff see SENT", { skip }, async () => {
  const pending = await MessageOutbox.count({ where: { status: "PENDING" } });
  assert.ok(pending >= 10, `rows 41–49 queued confirmations (${pending})`);

  // One message is still leased by "another worker": it must not be claimed. Taken from outside Guest Night, so
  // that event's guest list can show every confirmation as SENT below.
  const nightRegistrations = await Registration.findAll({ where: { event_id: guestFixture.nightId }, attributes: ["id"], raw: true });
  const leased = await MessageOutbox.findOne({
    where: { status: "PENDING", registration_id: { [Op.notIn]: nightRegistrations.map((row) => row.id) } },
    attributes: ["id"],
    raw: true,
  });
  assert.ok(leased);
  await MessageOutbox.update({ next_attempt_at: new Date(Date.now() + 60 * 60_000) }, { where: { id: leased.id } });

  let sent = 0;
  for (let run = 0; run < 10; run += 1) {
    const summary = await outboxDeliveryService.processDue();
    assert.deepEqual([summary.failed, summary.skipped, summary.retried], [0, 0, 0]);
    sent += summary.sent;
    if (summary.claimed === 0) break;
  }
  assert.equal(sent, pending - 1, "every due message, once");
  assert.equal(await MessageOutbox.count({ where: { status: "PENDING" } }), 1, "only the leased one waits");
  assert.equal(await MessageOutbox.count({ where: { status: "SENT", sent_at: { [Op.ne]: null }, attempts: 1 } }), pending - 1, "each sent on its first attempt");
  assert.equal((await outboxDeliveryService.processDue()).claimed, 0, "a second run sends nothing");

  const hana = await as("SELAM_OWNER", "GET", `${guestFixture.nightPath}/${guestFixture.hanaRegistrationId}`);
  assert.equal(hana.body.data.confirmation.status, "SENT", "staff see the delivery");
  const list = await as("SELAM_OWNER", "GET", guestFixture.nightPath);
  assert.ok(list.body.data.every((row: { confirmation: { status: string } | null }) => row.confirmation === null || row.confirmation.status === "SENT"));
});

// --- Phase 2b: roles and staff assignments (auth-cheche stubbed on the client: no network) ----------------

const NEW_STAFF_ID = "c7777777-7777-4777-8777-777777777777";
const STAFF_MOBILES: Record<string, string> = { "+251933000001": NEW_STAFF_ID, "+251933000002": PEOPLE.HORN_OWNER };
const staffBase = () => `/v1/organizations/${fixture.selamId}`;

function stubCentralUsers(options: { namesFail?: boolean } = {}) {
  mock.method(centralAuthClient, "findUserByMobile", async (mobile: string) => {
    const userId = STAFF_MOBILES[mobile];
    return userId ? { userId, mobile, firstname: "Dawit", middlename: null, lastname: "Staff", } : null;
  });
  mock.method(centralAuthClient, "getUsersByIds", async (ids: readonly string[]) => {
    if (options.namesFail) throw new CentralAuthUnavailableError();
    return ids.map((userId) => ({ userId, mobile: null, firstname: "Name", middlename: null, lastname: "Of Staff" }));
  });
}

async function asToken(token: string, method: string, path: string, body?: unknown) {
  return withServer(app, (baseUrl) => call(baseUrl, method, path, body === undefined ? { token } : { token, body }));
}

test("row 51: an owner lists roles, looks a person up by mobile and gives them a role; the same again changes nothing", { skip }, async () => {
  stubCentralUsers();
  try {
    const roles = await as("SELAM_OWNER", "GET", `${staffBase()}/roles`);
    assert.equal(roles.status, 200);
    const owner = roles.body.data.find((role: { code: string }) => role.code === "OWNER");
    const viewer = roles.body.data.find((role: { code: string }) => role.code === "VIEWER");
    assert.ok(owner && viewer);
    assert.deepEqual(
      owner.grants.find((grant: { module_code: string }) => grant.module_code === "USER_ROLES"),
      { module_code: "USER_ROLES", module_name: "Staff Assignments", view: true, create: true, update: true, delete: false, import: false, export: false, notify: false },
    );

    const lookup = await as("SELAM_OWNER", "GET", `${staffBase()}/staff-lookup?mobile=0933000001`);
    assert.deepEqual([lookup.status, lookup.body.data.user_id, lookup.body.data.firstname], [200, NEW_STAFF_ID, "Dawit"]);

    const added = await as("SELAM_OWNER", "POST", `${staffBase()}/staff-assignments`, { mobile: "0933000001", role_id: viewer.id });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.deepEqual([added.body.data.user_id, added.body.data.role.code, added.body.data.is_active], [NEW_STAFF_ID, "VIEWER", true]);
    const again = await as("SELAM_OWNER", "POST", `${staffBase()}/staff-assignments`, { mobile: "+251933000001", role_id: viewer.id });
    assert.deepEqual([again.status, again.body.data.id], [200, added.body.data.id]);

    const me = await asToken(await tokenFor(NEW_STAFF_ID), "GET", "/v1/auth/staff/me");
    assert.equal(me.body.data.assignment.organization.id, fixture.selamId, "the new person can sign in to Selam");
  } finally {
    mock.restoreAll();
  }
});

test("row 52: no Cheche account, someone already in another organization, or a platform role is refused", { skip }, async () => {
  stubCentralUsers();
  try {
    const roles = await as("SELAM_OWNER", "GET", `${staffBase()}/roles`);
    const viewerId = roles.body.data.find((role: { code: string }) => role.code === "VIEWER").id;
    const before = await UserRole.count();

    const unknown = await as("SELAM_OWNER", "POST", `${staffBase()}/staff-assignments`, { mobile: "0933000003", role_id: viewerId });
    assert.deepEqual([unknown.status, unknown.body.error.code], [404, "central_account_not_found"]);
    const elsewhere = await as("SELAM_OWNER", "POST", `${staffBase()}/staff-assignments`, { mobile: "0933000002", role_id: viewerId });
    assert.deepEqual([elsewhere.status, elsewhere.body.error.code], [409, "conflict"], "Horn's owner belongs to Horn");
    const superAdmin = await roleRepository.findPlatformRoleByCode("SUPER_ADMIN");
    assert.ok(superAdmin);
    const platform = await as("SELAM_OWNER", "POST", `${staffBase()}/staff-assignments`, { mobile: "0933000001", role_id: superAdmin.id });
    assert.equal(platform.status, 404, "a platform role is not a role of this organization");

    assert.equal(await UserRole.count(), before, "nothing written");
  } finally {
    mock.restoreAll();
  }
});

test("row 53: the organization always keeps an active Owner", { skip }, async () => {
  stubCentralUsers();
  try {
    const roles = await as("SELAM_OWNER", "GET", `${staffBase()}/roles`);
    const ownerRoleId = roles.body.data.find((role: { code: string }) => role.code === "OWNER").id;
    const viewerRoleId = roles.body.data.find((role: { code: string }) => role.code === "VIEWER").id;
    const staff = await as("SELAM_OWNER", "GET", `${staffBase()}/staff-assignments`);
    const original = staff.body.data.find((row: { user_id: string }) => row.user_id === PEOPLE.SELAM_OWNER);
    const newcomer = staff.body.data.find((row: { user_id: string }) => row.user_id === NEW_STAFF_ID);
    assert.ok(original && newcomer);
    assert.equal(original.profile.lastname, "Of Staff", "names come from Central Auth");

    const promoted = await as("SELAM_OWNER", "PATCH", `${staffBase()}/staff-assignments/${newcomer.id}`, { role_id: ownerRoleId });
    assert.deepEqual([promoted.status, promoted.body.data.role.code], [200, "OWNER"]);
    const stepDown = await as("SELAM_OWNER", "PATCH", `${staffBase()}/staff-assignments/${original.id}/status`, { is_active: false });
    assert.deepEqual([stepDown.status, stepDown.body.data.is_active], [200, false], "another Owner remains");

    const newOwner = await tokenFor(NEW_STAFF_ID);
    const lastOff = await asToken(newOwner, "PATCH", `${staffBase()}/staff-assignments/${newcomer.id}/status`, { is_active: false });
    assert.deepEqual([lastOff.status, lastOff.body.error.code], [409, "last_owner_assignment"]);
    const lastDemoted = await asToken(newOwner, "PATCH", `${staffBase()}/staff-assignments/${newcomer.id}`, { role_id: viewerRoleId });
    assert.deepEqual([lastDemoted.status, lastDemoted.body.error.code], [409, "last_owner_assignment"]);

    // Put Selam's original Owner back for the rows that follow.
    assert.equal((await asToken(newOwner, "PATCH", `${staffBase()}/staff-assignments/${original.id}/status`, { is_active: true })).status, 200);
    assert.equal((await as("SELAM_OWNER", "GET", `${staffBase()}/staff-assignments`)).status, 200, "the original Owner works again");
  } finally {
    mock.restoreAll();
  }
});

test("row 54: viewers, branch-limited staff and another tenant can't see or change staff", { skip }, async () => {
  stubCentralUsers();
  try {
    assert.equal((await as("SELAM_VIEWER", "GET", `${staffBase()}/staff-assignments`)).status, 403);
    assert.equal((await as("SELAM_VIEWER", "GET", `${staffBase()}/roles`)).status, 403);
    assert.equal((await as("SELAM_ADDIS", "GET", `${staffBase()}/staff-assignments`)).status, 403);
    assert.equal((await as("HORN_OWNER", "GET", `${staffBase()}/staff-assignments`)).status, 403);
    assert.equal((await as("SELAM_VIEWER", "GET", `${staffBase()}/staff-lookup?mobile=0933000001`)).status, 403);
  } finally {
    mock.restoreAll();
  }
});

test("row 55: when Central Auth can't give names, the staff list still answers with profile null", { skip }, async () => {
  stubCentralUsers({ namesFail: true });
  try {
    const staff = await as("SELAM_OWNER", "GET", `${staffBase()}/staff-assignments`);
    assert.equal(staff.status, 200);
    assert.ok(staff.body.data.length >= 3);
    assert.ok(staff.body.data.every((row: { profile: unknown }) => row.profile === null));
  } finally {
    mock.restoreAll();
  }
});

test("row 56: an organization created in the app gets OWNER and VIEWER; its first Owner is added by the Super Admin; the backfill repairs bare ones once", { skip }, async () => {
  const FIRST_OWNER_ID = "c8888888-8888-4888-8888-888888888888";
  mock.method(centralAuthClient, "findUserByMobile", async (mobile: string) =>
    mobile === "+251933000004" ? { userId: FIRST_OWNER_ID, mobile, firstname: "Meseret", middlename: null, lastname: "Owner" } : null,
  );
  mock.method(centralAuthClient, "getUsersByIds", async () => []);
  try {
    const created = await as("SUPER", "POST", "/v1/organizations", { organization: { name: "Pilot Org" } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const pilotId: string = created.body.data.organization.id;

    const roles = await as("SUPER", "GET", `/v1/organizations/${pilotId}/roles`);
    assert.deepEqual(roles.body.data.map((role: { code: string }) => role.code).sort(), ["OWNER", "VIEWER"]);
    const ownerRole = roles.body.data.find((role: { code: string }) => role.code === "OWNER");

    const firstOwner = await as("SUPER", "POST", `/v1/organizations/${pilotId}/staff-assignments`, { mobile: "0933000004", role_id: ownerRole.id });
    assert.equal(firstOwner.status, 201, JSON.stringify(firstOwner.body));
    const me = await asToken(await tokenFor(FIRST_OWNER_ID), "GET", "/v1/auth/staff/me");
    assert.deepEqual([me.body.data.assignment.organization.id, me.body.data.assignment.role.code], [pilotId, "OWNER"]);
  } finally {
    mock.restoreAll();
  }

  // The backfill: a bare organization (as the app made them before the fix) gets the defaults, once; others are untouched.
  const bare = await Organization.create({ name: "Bare Org", slug: "bare-org", description: null, created_by: null, updated_by: null });
  const selamRolesBefore = await Role.count({ where: { organization_id: fixture.selamId } });
  const queryInterface = sequelize.getQueryInterface();
  await backfillDefaultRoles({ context: queryInterface, name: "backfill", path: "" });
  await backfillDefaultRoles({ context: queryInterface, name: "backfill", path: "" });

  const bareRoles = await Role.findAll({ where: { organization_id: bare.id }, attributes: ["id", "code"], raw: true });
  assert.deepEqual(bareRoles.map((role) => role.code).sort(), ["OWNER", "VIEWER"], "once, even when run twice");
  const ownerGrants = await RoleModuleAccess.count({ where: { role_id: bareRoles.find((role) => role.code === "OWNER")?.id ?? "" } });
  assert.equal(ownerGrants, 7, "the OWNER grants of a new organization");
  assert.equal(await Role.count({ where: { organization_id: fixture.selamId } }), selamRolesBefore, "an organization with roles is untouched");
});

// --- Phase 2c: custom roles, organization editing and switching, the first Owner at creation -------------

const DOOR_ID = "c9999999-9999-4999-8999-999999999999";
const ABAY_OWNER_ID = "caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PHASE_2C_MOBILES: Record<string, string> = { "+251933000005": DOOR_ID, "+251933000006": ABAY_OWNER_ID, "+251933000001": NEW_STAFF_ID };
const roleFixture = { doorRoleId: "", doorAssignmentId: "", helpersRoleId: "" };

function stubPhase2cUsers() {
  mock.method(centralAuthClient, "findUserByMobile", async (mobile: string) => {
    const userId = PHASE_2C_MOBILES[mobile];
    return userId ? { userId, mobile, firstname: "Selam", middlename: null, lastname: "Staff" } : null;
  });
  mock.method(centralAuthClient, "getUsersByIds", async (ids: readonly string[]) =>
    ids.map((userId) => ({ userId, mobile: null, firstname: "Name", middlename: null, lastname: "Of Staff" })),
  );
}

const grantOf = (module_code: string, view: boolean, create: boolean, update: boolean) => ({ module_code, view, create, update });

test("row 57: an owner creates Door staff (guests view and update only) and assigns someone; they see and cancel guests, can't create events, and see only Guests", { skip }, async () => {
  stubPhase2cUsers();
  try {
    const created = await as("SELAM_OWNER", "POST", `${staffBase()}/roles`, {
      code: "door_staff",
      name: "Door staff",
      description: "Checks guests in at the door",
      grants: [grantOf("REGISTRATIONS", true, false, true)],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual([created.body.data.code, created.body.data.grants.length], ["DOOR_STAFF", 1]);
    roleFixture.doorRoleId = created.body.data.id;

    const added = await as("SELAM_OWNER", "POST", `${staffBase()}/staff-assignments`, { mobile: "0933000005", role_id: roleFixture.doorRoleId });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    roleFixture.doorAssignmentId = added.body.data.id;

    const door = await tokenFor(DOOR_ID);
    const guests = await asToken(door, "GET", guestFixture.nightPath);
    assert.equal(guests.status, 200);
    const confirmed = guests.body.data.find((row: { status: string }) => row.status === "CONFIRMED");
    assert.ok(confirmed, "a confirmed guest to cancel");
    const cancelled = await asToken(door, "PATCH", `${guestFixture.nightPath}/${confirmed.id}/status`, { status: "CANCELLED" });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    const back = await asToken(door, "PATCH", `${guestFixture.nightPath}/${confirmed.id}/status`, { status: "CONFIRMED" });
    assert.notEqual(back.status, 403, "bringing a guest back is an update too");

    const event = await asToken(door, "POST", `/v1/organizations/${fixture.selamId}/events`, { name: "Door Party" });
    assert.deepEqual([event.status, event.body.error.code], [403, "permission_denied"]);

    const me = await asToken(door, "GET", "/v1/auth/staff/me");
    const navigation: Array<{ code: string; children: Array<{ code: string }> }> = me.body.data.navigation;
    assert.deepEqual(navigation.find((node) => node.code === "EVENT_MANAGEMENT")?.children.map((child) => child.code), ["REGISTRATIONS"]);
    assert.ok(!navigation.some((node) => node.code === "ACCESS_CONTROL" || node.code === "ADMINISTRATION"));
  } finally {
    mock.restoreAll();
  }
});

test("row 58: the owner changes Door staff's grants and it applies on the very next request", { skip }, async () => {
  const door = await tokenFor(DOOR_ID);
  assert.equal((await asToken(door, "GET", `${staffBase()}/roles`)).status, 403);

  const edited = await as("SELAM_OWNER", "PATCH", `${staffBase()}/roles/${roleFixture.doorRoleId}`, {
    grants: [grantOf("REGISTRATIONS", true, false, true), grantOf("ROLES", true, false, true)],
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));

  assert.equal((await asToken(door, "GET", `${staffBase()}/roles`)).status, 200, "same token, new grants");
  const me = await asToken(door, "GET", "/v1/auth/staff/me");
  assert.deepEqual([me.body.data.permissions.ROLES.view, me.body.data.permissions.ROLES.update, me.body.data.permissions.ROLES.create], [true, true, false]);
});

test("row 59: platform modules and ORGANIZATIONS create are 400; someone with Roles › update can't grant what they don't hold (403)", { skip }, async () => {
  const before = await Role.count({ where: { organization_id: fixture.selamId } });
  const platform = await as("SELAM_OWNER", "POST", `${staffBase()}/roles`, { code: "ROGUE", name: "Rogue", grants: [grantOf("MODULES", true, false, false)] });
  assert.deepEqual([platform.status, platform.body.error.code], [400, "validation_error"]);
  const tenantCreate = await as("SELAM_OWNER", "POST", `${staffBase()}/roles`, { code: "ROGUE", name: "Rogue", grants: [grantOf("ORGANIZATIONS", true, true, false)] });
  assert.equal(tenantCreate.status, 400);
  assert.equal(await Role.count({ where: { organization_id: fixture.selamId } }), before, "nothing written");

  const helpers = await as("SELAM_OWNER", "POST", `${staffBase()}/roles`, { code: "HELPERS", name: "Helpers", grants: [] });
  assert.equal(helpers.status, 201);
  roleFixture.helpersRoleId = helpers.body.data.id;

  const door = await tokenFor(DOOR_ID);
  const escalate = await asToken(door, "PATCH", `${staffBase()}/roles/${roleFixture.helpersRoleId}`, {
    grants: [grantOf("REGISTRATIONS", true, false, false), grantOf("EVENTS", false, true, false)],
  });
  assert.deepEqual([escalate.status, escalate.body.error.code, escalate.body.error.details], [403, "grant_exceeds_own_access", { module_code: "EVENTS", action: "create" }]);
  const within = await asToken(door, "PATCH", `${staffBase()}/roles/${roleFixture.helpersRoleId}`, { grants: [grantOf("REGISTRATIONS", true, false, false)] });
  assert.equal(within.status, 200, "what they hold themselves, they may hand on");
});

test("row 60: OWNER is locked; a role staff still hold can't be switched off until they're reassigned", { skip }, async () => {
  stubPhase2cUsers();
  try {
    const roles = await as("SELAM_OWNER", "GET", `${staffBase()}/roles`);
    const ownerRole = roles.body.data.find((role: { code: string }) => role.code === "OWNER");
    const viewerRole = roles.body.data.find((role: { code: string }) => role.code === "VIEWER");
    const locked = await as("SELAM_OWNER", "PATCH", `${staffBase()}/roles/${ownerRole.id}`, { name: "Boss" });
    assert.deepEqual([locked.status, locked.body.error.code], [409, "role_locked"]);
    assert.equal((await as("SELAM_OWNER", "PATCH", `${staffBase()}/roles/${ownerRole.id}/status`, { is_active: false })).body.error.code, "role_locked");

    const inUse = await as("SELAM_OWNER", "PATCH", `${staffBase()}/roles/${roleFixture.doorRoleId}/status`, { is_active: false });
    assert.deepEqual([inUse.status, inUse.body.error.code, inUse.body.error.details], [409, "role_in_use", { active_assignments: 1 }]);

    const moved = await as("SELAM_OWNER", "PATCH", `${staffBase()}/staff-assignments/${roleFixture.doorAssignmentId}`, { role_id: viewerRole.id });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const off = await as("SELAM_OWNER", "PATCH", `${staffBase()}/roles/${roleFixture.doorRoleId}/status`, { is_active: false });
    assert.deepEqual([off.status, off.body.data.is_active], [200, false]);
    const assignToOff = await as("SELAM_OWNER", "PATCH", `${staffBase()}/staff-assignments/${roleFixture.doorAssignmentId}`, { role_id: roleFixture.doorRoleId });
    assert.equal(assignToOff.status, 409, "nobody is given a switched-off role");
    assert.equal((await as("SELAM_OWNER", "PATCH", `${staffBase()}/roles/${roleFixture.doorRoleId}/status`, { is_active: true })).status, 200);
  } finally {
    mock.restoreAll();
  }
});

test("row 61: the owner renames the organization (slug and links unchanged); only the Super Admin switches it off and on", { skip }, async () => {
  const selam = `/v1/organizations/${fixture.selamId}`;
  const catalog = "/v1/public/events?organization=selam-events";
  const listedBefore: number = (await publicGet(catalog)).body.meta.count;

  const renamed = await as("SELAM_OWNER", "PATCH", selam, { name: "Selam Events PLC", description: "Events in Addis" });
  assert.deepEqual([renamed.status, renamed.body.data.name, renamed.body.data.slug], [200, "Selam Events PLC", "selam-events"]);
  assert.equal((await as("SELAM_OWNER", "PATCH", selam, { slug: "selam-plc" })).status, 400);
  assert.equal((await publicGet(catalog)).body.meta.count, listedBefore, "the links still work");

  assert.equal((await as("SELAM_OWNER", "PATCH", `${selam}/status`, { is_active: false })).status, 403, "an Owner can't switch their own organization off");

  const off = await as("SUPER", "PATCH", `${selam}/status`, { is_active: false });
  assert.deepEqual([off.status, off.body.data.is_active], [200, false]);
  try {
    assert.equal((await publicGet(catalog)).body.meta.count, 0, "its events leave the catalog");
    const me = await as("SELAM_OWNER", "GET", "/v1/auth/staff/me");
    assert.deepEqual([me.status, me.body.error.code], [409, "organization_inactive"]);
    assert.equal((await as("SELAM_OWNER", "GET", branchesOf(fixture.selamId))).status, 403, "its staff can't act");
  } finally {
    const on = await as("SUPER", "PATCH", `${selam}/status`, { is_active: true });
    assert.equal(on.status, 200);
  }
  assert.equal((await publicGet(catalog)).body.meta.count, listedBefore, "everything returns");
  assert.equal((await as("SELAM_OWNER", "GET", "/v1/auth/staff/me")).status, 200);
  assert.equal((await as("SELAM_OWNER", "PATCH", selam, { name: "Selam Events" })).status, 200);
});

test("row 62: the Super Admin creates an organization with its first Owner in one step; an unknown mobile or existing staff create nothing", { skip }, async () => {
  stubPhase2cUsers();
  try {
    const before = await Organization.count();
    const unknown = await as("SUPER", "POST", "/v1/organizations", { organization: { name: "Abay Pilot" }, owner_mobile: "0933000007" });
    assert.deepEqual([unknown.status, unknown.body.error.code], [404, "central_account_not_found"]);
    const taken = await as("SUPER", "POST", "/v1/organizations", { organization: { name: "Abay Pilot" }, owner_mobile: "0933000001" });
    assert.deepEqual([taken.status, taken.body.error.code], [409, "conflict"], "already staff in Selam");
    assert.equal(await Organization.count(), before, "nothing created");

    const created = await as("SUPER", "POST", "/v1/organizations", { organization: { name: "Abay Pilot" }, owner_mobile: "0933000006" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.owner.user_id, ABAY_OWNER_ID);
    const me = await asToken(await tokenFor(ABAY_OWNER_ID), "GET", "/v1/auth/staff/me");
    assert.deepEqual([me.status, me.body.data.assignment.organization.id, me.body.data.assignment.role.code], [200, created.body.data.organization.id, "OWNER"]);
    assert.equal(me.body.data.permissions.ROLES.create, true, "a new Owner manages roles");
  } finally {
    mock.restoreAll();
  }
});

// --- Phase 4d: changing a guest's ticket type and exporting the guest list ---------------------------------

const swapFixture = { eventId: "", eventPath: "", guestsPath: "", gaId: "", vipId: "", vip2Id: "", oldId: "", hanaId: "", hanaCode: "", amharicId: "", formulaId: "" };

/** A raw download (the export is a file, not the JSON envelope). */
async function download(token: string, path: string): Promise<{ status: number; headers: Headers; bytes: Buffer }> {
  return withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: response.status, headers: response.headers, bytes: Buffer.from(await response.arrayBuffer()) };
  });
}

const tokenOf = (person: Person): string => {
  const token = tokens.get(person);
  assert.ok(token, `no token for ${person}`);
  return token;
};

test("row 63: the owner moves a guest to VIP (same code, no SMS, event total unchanged); full, inactive, cancelled and CLOSED are refused; two moves race for the last VIP place and one wins", { skip }, async () => {
  const swap = await createAndPublish("SELAM_OWNER", fixture.selamId, {
    name: "Seat Swap Gala",
    starts_at: "2027-11-20T18:00:00+03:00",
    ends_at: "2027-11-20T22:00:00+03:00",
    capacity: 10,
  });
  swapFixture.eventId = swap.id;
  swapFixture.eventPath = `/v1/organizations/${fixture.selamId}/events/${swap.id}`;
  swapFixture.guestsPath = `${swapFixture.eventPath}/registrations`;
  swapFixture.gaId = (await as("SELAM_OWNER", "GET", `${swapFixture.eventPath}/ticket-types`)).body.data[0].id;
  for (const [key, code, capacity] of [["vipId", "vip", 1], ["vip2Id", "vip2", 1], ["oldId", "old", null]] as const) {
    const created = await as("SELAM_OWNER", "POST", `${swapFixture.eventPath}/ticket-types`, { code, name: code.toUpperCase(), capacity });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    swapFixture[key] = created.body.data.id;
  }

  const guests: Array<[string, string, "hanaId" | "amharicId" | "formulaId"]> = [
    ["Hana", "+251922000001", "hanaId"],
    ["ሰላም", "+251922000002", "amharicId"],
    ["=SUM(1)", "+251922000003", "formulaId"],
  ];
  for (const [first_name, phone, key] of guests) {
    const registered = await as("SELAM_OWNER", "POST", swapFixture.guestsPath, { person: { first_name, last_name: "Swap", phone }, ticket_type_id: swapFixture.gaId });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    swapFixture[key] = registered.body.data.id;
    if (key === "hanaId") swapFixture.hanaCode = registered.body.data.code;
  }
  const move = (registrationId: string, ticketTypeId: string, person: Person = "SELAM_OWNER") =>
    as(person, "PATCH", `${swapFixture.guestsPath}/${registrationId}/ticket-type`, { ticket_type_id: ticketTypeId });

  const smsBefore = await MessageOutbox.count({ where: { registration_id: swapFixture.hanaId } });
  const moved = await move(swapFixture.hanaId, swapFixture.vipId);
  assert.deepEqual([moved.status, moved.body.message], [200, "Ticket type changed"], JSON.stringify(moved.body));
  assert.deepEqual([moved.body.data.id, moved.body.data.code, moved.body.data.ticket_type.code], [swapFixture.hanaId, swapFixture.hanaCode, "VIP"]);
  assert.equal(await MessageOutbox.count({ where: { registration_id: swapFixture.hanaId } }), smsBefore, "no new SMS");
  const summary = (await as("SELAM_OWNER", "GET", `${swapFixture.guestsPath}/summary`)).body.data;
  assert.equal(summary.confirmed, 3, "the event's total doesn't change");
  assert.equal(summary.ticket_types.find((row: { code: string }) => row.code === "VIP").confirmed, 1);
  assert.deepEqual([(await move(swapFixture.hanaId, swapFixture.vipId)).body.message], ["Ticket type unchanged"]);

  const full = await move(swapFixture.amharicId, swapFixture.vipId);
  assert.deepEqual([full.status, full.body.error.code, full.body.error.details.scope], [409, "capacity_reached", "TICKET_TYPE"]);

  const raced = await Promise.all([move(swapFixture.amharicId, swapFixture.vip2Id), move(swapFixture.formulaId, swapFixture.vip2Id)]);
  assert.deepEqual(raced.map((response) => response.status).sort(), [200, 409], JSON.stringify(raced.map((response) => response.body)));
  assert.equal(await Registration.count({ where: { event_id: swap.id, ticket_type_id: swapFixture.vip2Id, status: "CONFIRMED" } }), 1, "never overfilled");
  const loserId = raced[0]?.status === 409 ? swapFixture.amharicId : swapFixture.formulaId;

  assert.equal((await as("SELAM_OWNER", "PATCH", `${swapFixture.eventPath}/ticket-types/${swapFixture.oldId}/status`, { is_active: false })).status, 200);
  const inactive = await move(swapFixture.hanaId, swapFixture.oldId);
  assert.deepEqual([inactive.status, inactive.body.error.code], [409, "ticket_type_inactive"]);

  assert.equal((await as("SELAM_OWNER", "PATCH", `${swapFixture.guestsPath}/${loserId}/status`, { status: "CANCELLED" })).status, 200);
  const cancelled = await move(loserId, swapFixture.gaId);
  assert.deepEqual([cancelled.status, cancelled.body.error.code], [409, "registration_cancelled"]);

  assert.equal((await move(swapFixture.hanaId, swapFixture.gaId, "SELAM_VIEWER")).status, 403, "a viewer can't move guests");
  assert.equal((await as("SELAM_OWNER", "PATCH", `${swapFixture.eventPath}/status`, { status: "CLOSED" })).status, 200);
  const closed = await move(swapFixture.hanaId, swapFixture.gaId);
  assert.deepEqual([closed.status, closed.body.error.code, closed.body.error.details.status], [409, "invalid_event_state", "CLOSED"]);
  assert.equal((await Registration.findByPk(swapFixture.hanaId, { raw: true }))?.ticket_type_id, swapFixture.vipId, "nothing changed");
});

test("row 64: the owner downloads the guest list as CSV (BOM, filters, Amharic intact, formulas neutralised, Ethiopian then Gregorian dates); a viewer reads the list but can't export", { skip }, async () => {
  const exportPath = `${swapFixture.guestsPath}/export`;
  const all = await download(tokenOf("SELAM_OWNER"), exportPath);
  assert.equal(all.status, 200, all.bytes.toString("utf8"));
  assert.equal(all.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(all.headers.get("content-disposition"), 'attachment; filename="seat-swap-gala-guests.csv"');
  assert.equal(all.bytes.subarray(0, 3).toString("hex"), "efbbbf", "byte-order mark");

  const lines = all.bytes.toString("utf8").replace(/^\uFEFF/, "").trimEnd().split("\r\n");
  assert.match(lines[0] ?? "", /^Code,Status,First name,Last name,Mobile,/);
  assert.equal(lines.length, 4, "header plus all three guests");
  const hana = lines.find((line) => line.startsWith(swapFixture.hanaCode)) ?? "";
  assert.match(hana, /,Confirmed,Hana,Swap,0922 000 001,,,VIP,Added by staff,/);
  assert.match(hana, /"[A-Z][a-z]+ \d{1,2}, \d{4} at \d{1,2}:\d{2} (in the morning|in the afternoon|in the evening|at night)","[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} (AM|PM)",,$/);
  assert.ok(lines.some((line) => line.includes(",ሰላም,Swap,")), "Amharic kept");
  assert.ok(lines.some((line) => line.includes(",'=SUM(1),Swap,")), "the formula can't run");

  const confirmed = await download(tokenOf("SELAM_OWNER"), `${exportPath}?status=CONFIRMED`);
  assert.equal(confirmed.bytes.toString("utf8").trimEnd().split("\r\n").length, 3, "the cancelled guest is filtered out");
  const searched = await download(tokenOf("SELAM_OWNER"), `${exportPath}?q=0922000001`);
  assert.equal(searched.bytes.toString("utf8").trimEnd().split("\r\n").length, 2, "search by local mobile");

  assert.equal((await as("SELAM_VIEWER", "GET", swapFixture.guestsPath)).status, 200);
  const viewer = await download(tokenOf("SELAM_VIEWER"), exportPath);
  assert.equal(viewer.status, 403);
  assert.equal(JSON.parse(viewer.bytes.toString("utf8")).error.code, "permission_denied");
  assert.equal((await download(tokenOf("HORN_OWNER"), exportPath)).status, 403, "another tenant");
});

test("row 65: the migration gives existing Owners Export; a role holder gets it only when given it; Export on Events is 400; nobody grants Export without holding it", { skip }, async () => {
  const registrations = await moduleRepository.findActivePermissionByCode("REGISTRATIONS");
  assert.ok(registrations);
  const hornOwner = await Role.findOne({ where: { organization_id: fixture.hornId, code: "OWNER" }, raw: true });
  assert.ok(hornOwner);
  await RoleModuleAccess.update({ can_export: false }, { where: { role_id: hornOwner.id, module_id: registrations.id } });
  await grantGuestExportToOwners({ context: sequelize.getQueryInterface(), name: "guest-export", path: "" });
  assert.equal((await RoleModuleAccess.findOne({ where: { role_id: hornOwner.id, module_id: registrations.id }, raw: true }))?.can_export, true);
  const selamViewer = await Role.findOne({ where: { organization_id: fixture.selamId, code: "VIEWER" }, raw: true });
  assert.ok(selamViewer);
  assert.equal((await RoleModuleAccess.findOne({ where: { role_id: selamViewer.id, module_id: registrations.id }, raw: true }))?.can_export, false, "Viewers don't get it");

  stubPhase2cUsers();
  try {
    const back = await as("SELAM_OWNER", "PATCH", `${staffBase()}/staff-assignments/${roleFixture.doorAssignmentId}`, { role_id: roleFixture.doorRoleId });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    const door = await tokenFor(DOOR_ID);
    const exportPath = `${swapFixture.guestsPath}/export`;
    assert.equal((await download(door, exportPath)).status, 403, "Door staff can't export yet");

    const escalate = await asToken(door, "PATCH", `${staffBase()}/roles/${roleFixture.helpersRoleId}`, {
      grants: [{ ...grantOf("REGISTRATIONS", true, false, false), export: true }],
    });
    assert.deepEqual([escalate.status, escalate.body.error.code, escalate.body.error.details], [403, "grant_exceeds_own_access", { module_code: "REGISTRATIONS", action: "export" }]);

    const given = await as("SELAM_OWNER", "PATCH", `${staffBase()}/roles/${roleFixture.doorRoleId}`, {
      grants: [{ ...grantOf("REGISTRATIONS", true, false, true), export: true }, grantOf("ROLES", true, false, true)],
    });
    assert.equal(given.status, 200, JSON.stringify(given.body));
    assert.equal((await download(door, exportPath)).status, 200, "same token, new right");
    assert.equal((await asToken(door, "GET", "/v1/auth/staff/me")).body.data.permissions.REGISTRATIONS.export, true);

    const oldScreen = await as("SELAM_OWNER", "PATCH", `${staffBase()}/roles/${roleFixture.doorRoleId}`, {
      grants: [grantOf("REGISTRATIONS", true, false, true), grantOf("ROLES", true, false, true)],
    });
    const kept = oldScreen.body.data.grants.find((row: { module_code: string }) => row.module_code === "REGISTRATIONS");
    assert.equal(kept.export, true, "a save that doesn't send export keeps it");

    const onEvents = await as("SELAM_OWNER", "POST", `${staffBase()}/roles`, { code: "EXPORTER", name: "Exporter", grants: [{ ...grantOf("EVENTS", true, false, false), export: true }] });
    assert.deepEqual([onEvents.status, onEvents.body.error.details.issues[0].path], [400, "body.grants.0.export"]);
  } finally {
    mock.restoreAll();
  }
});
