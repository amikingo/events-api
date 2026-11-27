import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, mock, test } from "node:test";
import jwt from "jsonwebtoken";
import { Op } from "sequelize";
import { createApp } from "../../src/app.js";
import { centralAuthClient } from "../../src/clients/central-auth.client.js";
import { chechePayClient } from "../../src/clients/cheche-pay.client.js";
import { CUSTOMER_REFRESH_COOKIE } from "../../src/config/app.js";
import { authConfig } from "../../src/config/auth.js";
import { filesConfig } from "../../src/config/files.js";
import { PRIVACY_NOTICE_VERSION } from "../../src/config/privacy.js";
import { sequelize } from "../../src/db.js";
import {
  CentralAuthRefusedError,
  CentralAuthUnavailableError,
  ConflictError,
  InvalidBranchStateError,
  InvalidCredentialsError,
  StaffAssignmentNotFoundError,
} from "../../src/errors/app-errors.js";
import { authLoginLimiter, authRefreshLimiter, customerAuthLimiter, customerCodePerMobileLimiter, publicRegistrationLimiter } from "../../src/middleware/rate-limit.js";
import { up as backfillDefaultRoles } from "../../src/migrations/20261127000100-backfill-default-roles.js";
import { up as grantGuestExportToOwners } from "../../src/migrations/20261129000000-grant-guest-export-to-owners.js";
import { up as grantAllActionsToOwnerRoles } from "../../src/migrations/20261202000000-grant-all-actions-to-owner-roles.js";
import { migrator } from "../../src/migrator.js";
import { TENANT_GRANTABLE } from "../../src/utils/rbac.js";
import {
  AppEvent,
  Branch,
  CustomerAccount,
  MessageOutbox,
  OrderPayment,
  Organization,
  OrganizationChechePayCredential,
  PaymentCase,
  Person as PersonModel,
  Registration,
  Role,
  RoleModuleAccess,
  RoleTemplate,
  RoleTemplateModuleAccess,
  StoredFile,
  SubmissionKey,
  TicketAdmission,
  TicketOrder,
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
import { paymentService } from "../../src/services/payment.service.js";
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
  // Phase 2e: Owners hold all 7 actions on tenant modules, delete included.
  assert.deepEqual([branches.view, branches.create, branches.update, branches.delete], [true, true, true, true]);
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
  // Phase 7 added the price, currency and is_free (Phase 11: the price now, and price_valid_until, null without windows).
  assert.deepEqual(unlisted.body.data.ticket_types, [{ code: "GA", name: "General Admission", price: "0.00", currency: "ETB", is_free: true, price_valid_until: null }]);
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
    queued.map((message) => [message.kind, message.channel, message.recipient, message.status, "code" in message.payload ? message.payload.code : null]),
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
  // Phase 7: a ticket needs a real order of the event, so only the person or ticket type can be the wrong one here.
  const hanaTicket = await Registration.findByPk(guestFixture.hanaRegistrationId, { raw: true });
  assert.ok(hanaTicket);
  const direct = {
    organization_id: fixture.selamId,
    event_id: guestFixture.nightId,
    order_id: hanaTicket.order_id,
    currency: "ETB",
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
      // Phase 2e: Owners hold all 7 actions on tenant modules.
      { module_code: "USER_ROLES", module_name: "Staff Assignments", view: true, create: true, update: true, delete: true, import: true, export: true, notify: true },
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
  // Phase 7: after the (empty) cancelled dates come the order reference and the buyer's mobile; Phase 8: then the
  // (empty, not checked in) check-in dates.
  assert.match(hana, /"[A-Z][a-z]+ \d{1,2}, \d{4} at \d{1,2}:\d{2} (in the morning|in the afternoon|in the evening|at night)","[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} (AM|PM)",,,[A-HJKMNP-Z2-9]{10},0922 000 001,,$/);
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

test("row 65: the migration gives existing Owners Export; a role holder gets it only when given it; Organizations delete is 400; nobody grants Export without holding it", { skip }, async () => {
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

    // Phase 2e: export is grantable on every tenant module; Organizations create and delete never are.
    const onOrganizations = await as("SELAM_OWNER", "POST", `${staffBase()}/roles`, { code: "EXPORTER", name: "Exporter", grants: [{ ...grantOf("ORGANIZATIONS", true, false, false), delete: true }] });
    assert.deepEqual([onOrganizations.status, onOrganizations.body.error.details.issues[0].path], [400, "body.grants.0.delete"]);
  } finally {
    mock.restoreAll();
  }
});

// --- Phase 6: guest accounts and My Tickets (auth-cheche stubbed; guest tokens signed as auth-cheche signs them) ---

const GUESTS = {
  HANA: { id: "d1111111-1111-4111-8111-111111111111", mobile: "+251944000001" },
  ABEL: { id: "d2222222-2222-4222-8222-222222222222", mobile: "+251944000002" },
  SARA: { id: "d3333333-3333-4333-8333-333333333333", mobile: "+251944000003" },
} as const;
type Guest = keyof typeof GUESTS;

/** An auth-cheche access token for a guest (HS256, iss auth_api, token_type access), with the account's mobile. */
function guestAccessToken(guest: Guest): string {
  const { id, mobile } = GUESTS[guest];
  return jwt.sign({ user_id: id, token_type: "access", mobile, firstname: guest, lastname: "Guest" }, authConfig.centralAuthJwtSecret, {
    algorithm: "HS256",
    expiresIn: 3 * 24 * 3600,
    issuer: authConfig.centralIssuer,
    subject: id,
  });
}

const guestFixturePhase6 = { selamGalaSlug: "", abayDaySlug: "", abaySlug: "", abayId: "", selamFairSlug: "", selamMarketSlug: "" };

async function guestPost(path: string, body: unknown, options: { token?: string; key?: string; cookie?: string } = {}) {
  return withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(options.key ? { "Idempotency-Key": options.key } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.cookie ? { Cookie: `${CUSTOMER_REFRESH_COOKIE}=${options.cookie}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, setCookie: response.headers.getSetCookie() };
  });
}

async function guestGet(path: string, token?: string) {
  return withServer(app, (baseUrl) => call(baseUrl, "GET", path, token ? { token } : {}));
}

/** A signed-in guest registers on the public form (a fresh retry key each time, as each press of Register makes). */
function registerSignedIn(guest: Guest | null, organizationSlug: string, eventSlug: string, extra: Record<string, unknown> = {}) {
  return guestPost(
    `/v1/public/organizations/${organizationSlug}/events/${eventSlug}/registrations`,
    { first_name: guest ?? "Walk", last_name: "Guest", privacy_notice_version: PRIVACY_NOTICE_VERSION, ...extra },
    { key: randomUUID(), ...(guest ? { token: guestAccessToken(guest) } : {}) },
  );
}

const resetGuestLimits = () => {
  publicRegistrationLimiter.resetKey("127.0.0.1");
  customerAuthLimiter.resetKey("127.0.0.1");
  authRefreshLimiter.resetKey("127.0.0.1");
  for (const { mobile } of Object.values(GUESTS)) customerCodePerMobileLimiter.resetKey(`mobile:${mobile}`);
};

test("row 66: a guest signs up, confirms and is signed in; the refresh cookie rotates and logout clears it; guest and staff tokens never cross", { skip }, async () => {
  resetGuestLimits();
  const tokensFor = (refreshToken: string) => ({ accessToken: guestAccessToken("HANA"), refreshToken, refreshExpiresIn: 7 * 24 * 3600 });
  mock.method(centralAuthClient, "signUpWithPassword", async () => undefined);
  mock.method(centralAuthClient, "verifyCode", async () => undefined);
  mock.method(centralAuthClient, "passwordLogin", async () => tokensFor("refresh-1"));
  mock.method(centralAuthClient, "refreshAccessToken", async () => tokensFor("refresh-2"));
  const logout = mock.method(centralAuthClient, "logout", async (_token: string) => undefined);
  try {
    const signUp = await guestPost("/v1/auth/customer/signup", { first_name: "Hana", last_name: "Guest", mobile: "0944000001", password: "pass-1234" });
    assert.equal(signUp.status, 201, JSON.stringify(signUp.body));
    const confirmed = await guestPost("/v1/auth/customer/signup/confirm", { mobile: "0944000001", otp: "123456", password: "pass-1234" });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.deepEqual([confirmed.body.data.user.id, confirmed.body.data.user.mobile], [GUESTS.HANA.id, GUESTS.HANA.mobile]);
    assert.ok(confirmed.setCookie.some((header) => header.startsWith(`${CUSTOMER_REFRESH_COOKIE}=refresh-1;`)));

    const renewed = await guestPost("/v1/auth/customer/refresh", {}, { cookie: "refresh-1" });
    assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
    assert.ok(renewed.setCookie.some((header) => header.startsWith(`${CUSTOMER_REFRESH_COOKIE}=refresh-2;`)), "the cookie rotates");

    const out = await guestPost("/v1/auth/customer/logout", {}, { cookie: "refresh-2" });
    assert.equal(out.status, 200);
    assert.equal(logout.mock.calls[0]?.arguments[0], "refresh-2");
    assert.ok(out.setCookie.some((header) => header.startsWith(`${CUSTOMER_REFRESH_COOKIE}=;`)), "the cookie is cleared");
  } finally {
    mock.restoreAll();
  }

  const guest = guestAccessToken("HANA");
  assert.equal((await guestGet("/v1/auth/staff/me", guest)).status, 401, "a guest token can't reach staff routes");
  assert.equal((await guestGet(`/v1/organizations/${fixture.selamId}/events`, guest)).status, 401);
  assert.equal((await guestGet("/v1/customer/registrations", tokens.get("SELAM_OWNER"))).status, 401, "a staff token can't reach My Tickets");
});

test("row 67: a signed-in guest registers with two organizers: one linked profile in each, with the account's mobile; registering again returns the same code", { skip }, async () => {
  resetGuestLimits();
  const gala = await createAndPublish("SELAM_OWNER", fixture.selamId, { name: "Selam Gala", starts_at: "2027-12-10T18:00:00+03:00", ends_at: "2027-12-10T22:00:00+03:00" });
  // The second organizer is Abay Pilot (row 62): Horn was switched off in row 37 and stays off.
  const abay = await Organization.findOne({ where: { name: "Abay Pilot" }, raw: true });
  assert.ok(abay, "row 62 created Abay Pilot");
  const abayOwner = await tokenFor(ABAY_OWNER_ID);
  const created = await asToken(abayOwner, "POST", `/v1/organizations/${abay.id}/events`, {
    name: "Abay Health Day",
    starts_at: "2027-08-01T09:00:00+03:00",
    ends_at: "2027-08-01T17:00:00+03:00",
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const published = await asToken(abayOwner, "PATCH", `/v1/organizations/${abay.id}/events/${created.body.data.id}/status`, { status: "PUBLISHED" });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  Object.assign(guestFixturePhase6, { selamGalaSlug: gala.slug, abayDaySlug: created.body.data.slug, abaySlug: abay.slug, abayId: abay.id });

  const atSelam = await registerSignedIn("HANA", "selam-events", gala.slug, { phone: "+251999999999" });
  assert.equal(atSelam.status, 201, JSON.stringify(atSelam.body));
  const atAbay = await registerSignedIn("HANA", abay.slug, guestFixturePhase6.abayDaySlug);
  assert.equal(atAbay.status, 201, JSON.stringify(atAbay.body));

  const profiles = await PersonModel.findAll({ where: { user_id: GUESTS.HANA.id }, raw: true });
  assert.deepEqual(profiles.map((profile) => profile.organization_id).sort(), [fixture.selamId, abay.id].sort());
  assert.ok(profiles.every((profile) => profile.phone === GUESTS.HANA.mobile), "the account's mobile, never the form's");

  const again = await registerSignedIn("HANA", "selam-events", gala.slug);
  assert.deepEqual([again.status, again.body.data.code], [200, atSelam.body.data.code]);
  assert.equal(await PersonModel.count({ where: { user_id: GUESTS.HANA.id } }), 2, "no new profile");
});

test("row 68: My Tickets shows both registrations with their organizers, upcoming first; a staff cancellation shows; another guest sees none", { skip }, async () => {
  const mine = await guestGet("/v1/customer/registrations", guestAccessToken("HANA"));
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.deepEqual(
    mine.body.data.map((ticket: { organization: { slug: string }; event: { slug: string } }) => [ticket.organization.slug, ticket.event.slug]),
    [
      [guestFixturePhase6.abaySlug, guestFixturePhase6.abayDaySlug],
      ["selam-events", guestFixturePhase6.selamGalaSlug],
    ],
    "the August event before the December one",
  );
  const serialized = JSON.stringify(mine.body.data);
  assert.ok(!serialized.includes(fixture.selamId) && !serialized.includes(GUESTS.HANA.id), "no internal ids");

  const gala = await AppEvent.findOne({ where: { organization_id: fixture.selamId, slug: guestFixturePhase6.selamGalaSlug }, raw: true });
  assert.ok(gala);
  const selamTicket = mine.body.data[1];
  const registration = await Registration.findOne({ where: { event_id: gala.id, code: selamTicket.code }, raw: true });
  assert.ok(registration);
  const cancelled = await as("SELAM_OWNER", "PATCH", `/v1/organizations/${fixture.selamId}/events/${gala.id}/registrations/${registration.id}/status`, { status: "CANCELLED" });
  assert.equal(cancelled.status, 200);
  const after = await guestGet("/v1/customer/registrations", guestAccessToken("HANA"));
  assert.equal(after.body.data[1].status, "CANCELLED");

  assert.deepEqual((await guestGet("/v1/customer/registrations", guestAccessToken("ABEL"))).body.data, [], "another guest sees nothing");
});

test("row 69: a registration made without signing in, with the same mobile, never appears in My Tickets; without a token the profile stays unlinked", { skip }, async () => {
  resetGuestLimits();
  const fair = await createAndPublish("SELAM_OWNER", fixture.selamId, { name: "Selam Fair", starts_at: "2027-09-05T09:00:00+03:00", ends_at: "2027-09-05T17:00:00+03:00" });
  guestFixturePhase6.selamFairSlug = fair.slug;

  const anonymous = await registerSignedIn(null, "selam-events", fair.slug, { phone: GUESTS.HANA.mobile });
  assert.equal(anonymous.status, 201, JSON.stringify(anonymous.body));
  const walkIn = await Registration.findOne({ where: { event_id: fair.id }, include: [{ model: PersonModel, as: "person" }] });
  assert.equal((walkIn?.get({ plain: true }) as unknown as { person: { user_id: string | null } }).person.user_id, null, "unlinked");

  const mine = await guestGet("/v1/customer/registrations", guestAccessToken("HANA"));
  assert.ok(!mine.body.data.some((ticket: { event: { slug: string } }) => ticket.event.slug === fair.slug), "not claimed by a matching mobile");

  const missingPhone = await registerSignedIn(null, "selam-events", fair.slug);
  assert.deepEqual([missingPhone.status, missingPhone.body.error.details.issues[0].path], [400, "body.phone"]);

  const signedInToo = await registerSignedIn("HANA", "selam-events", fair.slug);
  assert.equal(signedInToo.status, 201, "a separate profile until claiming is built");
});

test("row 70: a new guest registering for two events of one organizer at the same moment ends up with exactly one linked profile there", { skip }, async () => {
  resetGuestLimits();
  const market = await createAndPublish("SELAM_OWNER", fixture.selamId, { name: "Selam Market", starts_at: "2027-10-02T09:00:00+03:00", ends_at: "2027-10-02T17:00:00+03:00" });
  guestFixturePhase6.selamMarketSlug = market.slug;

  const results = await Promise.all([
    registerSignedIn("SARA", "selam-events", market.slug),
    registerSignedIn("SARA", "selam-events", guestFixturePhase6.selamFairSlug),
  ]);
  assert.deepEqual(results.map((response) => response.status), [201, 201], JSON.stringify(results.map((response) => response.body)));
  assert.equal(await PersonModel.count({ where: { organization_id: fixture.selamId, user_id: GUESTS.SARA.id } }), 1);
  assert.equal((await guestGet("/v1/customer/registrations", guestAccessToken("SARA"))).body.data.length, 2);
});

// --- Phase 2d: permission overrides, role templates and modules ---------------------------------------------

const overridesOf = (assignmentId: string) => `${staffBase()}/staff-assignments/${assignmentId}/overrides`;

async function assignmentIdOf(userId: string): Promise<string> {
  const [assignment] = await userRoleRepository.listActiveAssignmentsByUser(userId);
  assert.ok(assignment, `an active assignment for ${userId}`);
  return assignment.id;
}

test("row 71: an override lets a Viewer export guests; a deny takes Guests away from a custom role holder; both apply on the next request", { skip }, async () => {
  const viewerAssignment = await assignmentIdOf(PEOPLE.SELAM_VIEWER);
  const exportPath = `${swapFixture.guestsPath}/export`;
  assert.equal((await download(tokenOf("SELAM_VIEWER"), exportPath)).status, 403, "Viewers can't export");

  const allow = await as("SELAM_OWNER", "PUT", overridesOf(viewerAssignment), { overrides: [{ module_code: "REGISTRATIONS", export: true }] });
  assert.equal(allow.status, 200, JSON.stringify(allow.body));
  const guests = allow.body.data.modules.find((module: { module_code: string }) => module.module_code === "REGISTRATIONS");
  assert.deepEqual([guests.role.export, guests.override.export, guests.effective.export], [false, true, true]);
  assert.equal((await download(tokenOf("SELAM_VIEWER"), exportPath)).status, 200, "same token, new access");

  const door = await tokenFor(DOOR_ID);
  assert.equal((await asToken(door, "GET", swapFixture.guestsPath)).status, 200);
  const deny = await as("SELAM_OWNER", "PUT", overridesOf(roleFixture.doorAssignmentId), { overrides: [{ module_code: "REGISTRATIONS", view: false }] });
  assert.equal(deny.status, 200, JSON.stringify(deny.body));
  assert.equal((await asToken(door, "GET", swapFixture.guestsPath)).status, 403, "the deny wins over the role");
  const me = await asToken(door, "GET", "/v1/auth/staff/me");
  const navigation: Array<{ code: string; children: Array<{ code: string }> }> = me.body.data.navigation;
  assert.ok(!navigation.some((node) => node.children.some((child) => child.code === "REGISTRATIONS")), "Guests leaves the menu");

  const listed = await as("SELAM_OWNER", "GET", overridesOf(roleFixture.doorAssignmentId));
  assert.equal(listed.body.data.modules.find((module: { module_code: string }) => module.module_code === "REGISTRATIONS").override.view, false);
});

test("row 72: overrides on an Owner or on yourself are 409; a platform module is 400; allowing what you don't hold is 403", { skip }, async () => {
  const ownerAssignment = await assignmentIdOf(PEOPLE.SELAM_OWNER);
  const onOwner = await as("SELAM_OWNER", "PUT", overridesOf(ownerAssignment), { overrides: [{ module_code: "EVENTS", view: false }] });
  assert.deepEqual([onOwner.status, onOwner.body.error.code], [409, "owner_not_overridable"]);

  const viewerAssignment = await assignmentIdOf(PEOPLE.SELAM_VIEWER);
  const platform = await as("SELAM_OWNER", "PUT", overridesOf(viewerAssignment), { overrides: [{ module_code: "MODULES", view: true }] });
  assert.deepEqual([platform.status, platform.body.error.details.issues[0].path], [400, "body.overrides.0.module_code"]);

  // Door staff may now manage staff, but holds no Events › create and can't touch their own access.
  const given = await as("SELAM_OWNER", "PATCH", `${staffBase()}/roles/${roleFixture.doorRoleId}`, {
    grants: [{ ...grantOf("REGISTRATIONS", true, false, true), export: true }, grantOf("ROLES", true, false, true), grantOf("USER_ROLES", true, false, true)],
  });
  assert.equal(given.status, 200, JSON.stringify(given.body));
  const door = await tokenFor(DOOR_ID);
  const own = await asToken(door, "PUT", overridesOf(roleFixture.doorAssignmentId), { overrides: [] });
  assert.deepEqual([own.status, own.body.error.code], [409, "own_assignment"]);
  const escalate = await asToken(door, "PUT", overridesOf(viewerAssignment), { overrides: [{ module_code: "EVENTS", create: true }] });
  assert.deepEqual([escalate.status, escalate.body.error.code, escalate.body.error.details], [403, "grant_exceeds_own_access", { module_code: "EVENTS", action: "create" }]);
  const denyOnly = await asToken(door, "PUT", overridesOf(viewerAssignment), { overrides: [{ module_code: "EVENTS", view: false }] });
  assert.equal(denyOnly.status, 200, "denying needs no access of your own");
});

const templateFixture = { doorTemplateId: "" };

test("row 73: the Super Admin creates a template; new organizations get it only once it's marked for new organizations", { skip }, async () => {
  const created = await as("SUPER", "POST", "/v1/role-templates", {
    code: "door_helper",
    name: "Door helper",
    grants: [grantOf("REGISTRATIONS", true, false, true)],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual([created.body.data.code, created.body.data.for_new_organizations, created.body.data.locked], ["DOOR_HELPER", false, false]);
  templateFixture.doorTemplateId = created.body.data.id;

  const before = await as("SUPER", "POST", "/v1/organizations", { organization: { name: "Template Org One" } });
  assert.equal(before.status, 201, JSON.stringify(before.body));
  const rolesBefore = (await Role.findAll({ where: { organization_id: before.body.data.organization.id }, raw: true })).map((role) => role.code).sort();
  assert.deepEqual(rolesBefore, ["OWNER", "VIEWER"], "from the seeded templates");

  const marked = await as("SUPER", "PATCH", `/v1/role-templates/${templateFixture.doorTemplateId}`, { for_new_organizations: true });
  assert.equal(marked.status, 200, JSON.stringify(marked.body));
  const after = await as("SUPER", "POST", "/v1/organizations", { organization: { name: "Template Org Two" } });
  assert.equal(after.status, 201, JSON.stringify(after.body));
  const rolesAfter = (await Role.findAll({ where: { organization_id: after.body.data.organization.id }, raw: true })).map((role) => role.code).sort();
  assert.deepEqual(rolesAfter, ["DOOR_HELPER", "OWNER", "VIEWER"]);
});

test("row 74: an Owner starts a role from a template; editing the template later never changes it; the OWNER template is locked", { skip }, async () => {
  const listed = await as("SELAM_OWNER", "GET", `${staffBase()}/role-templates`);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const doorTemplate = listed.body.data.find((template: { code: string }) => template.code === "DOOR_HELPER");
  assert.ok(doorTemplate, "active templates are offered to Owners");

  const fromTemplate = await as("SELAM_OWNER", "POST", `${staffBase()}/roles`, {
    code: "door_helper",
    name: "Door helper",
    grants: doorTemplate.grants.map((grant: { module_code: string; view: boolean; create: boolean; update: boolean; export: boolean }) => ({
      module_code: grant.module_code,
      view: grant.view,
      create: grant.create,
      update: grant.update,
      export: grant.export,
    })),
  });
  assert.equal(fromTemplate.status, 201, JSON.stringify(fromTemplate.body));

  const edited = await as("SUPER", "PATCH", `/v1/role-templates/${templateFixture.doorTemplateId}`, {
    grants: [grantOf("REGISTRATIONS", true, false, true), grantOf("EVENTS", true, false, false)],
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const role = await as("SELAM_OWNER", "GET", `${staffBase()}/roles/${fromTemplate.body.data.id}`);
  assert.deepEqual(role.body.data.grants.map((grant: { module_code: string }) => grant.module_code), ["REGISTRATIONS"], "a copy, never a link");

  const owner = (await as("SUPER", "GET", "/v1/role-templates")).body.data.find((template: { code: string }) => template.code === "OWNER");
  assert.equal(owner.locked, true);
  const lockedEdit = await as("SUPER", "PATCH", `/v1/role-templates/${owner.id}`, { name: "Boss" });
  assert.deepEqual([lockedEdit.status, lockedEdit.body.error.code], [409, "role_locked"]);
  assert.equal((await as("SUPER", "PATCH", `/v1/role-templates/${owner.id}/status`, { is_active: false })).status, 409);
});

test("row 75: the Super Admin renames and reorders a module and /me follows; Owners can't reach modules or the template library", { skip }, async () => {
  const registrations = await moduleRepository.findActivePermissionByCode("REGISTRATIONS");
  assert.ok(registrations);
  const renamed = await as("SUPER", "PATCH", `/v1/modules/${registrations.id}`, { module_name: "Guest list", sno: 9 });
  assert.deepEqual([renamed.status, renamed.body.data.module_name, renamed.body.data.code], [200, "Guest list", "REGISTRATIONS"]);
  try {
    const me = await as("SELAM_OWNER", "GET", "/v1/auth/staff/me");
    const child = (me.body.data.navigation as Array<{ children: Array<{ code: string; module_name: string; sno: number }> }>)
      .flatMap((node) => node.children)
      .find((node) => node.code === "REGISTRATIONS");
    assert.deepEqual([child?.module_name, child?.sno], ["Guest list", 9]);

    const tree = await as("SUPER", "GET", "/v1/modules");
    assert.ok((tree.body.data as Array<{ code: string }>).some((node) => node.code === "EVENT_MANAGEMENT"));
    assert.equal((await as("SUPER", "PATCH", `/v1/modules/${registrations.id}`, { code: "GUESTS" })).status, 400, "the code can't change");

    assert.equal((await as("SELAM_OWNER", "GET", "/v1/modules")).status, 403);
    assert.equal((await as("SELAM_OWNER", "GET", "/v1/role-templates")).status, 403);
    assert.equal((await as("SELAM_OWNER", "POST", "/v1/role-templates", { code: "X", name: "X", grants: [] })).status, 403);
  } finally {
    await as("SUPER", "PATCH", `/v1/modules/${registrations.id}`, { module_name: "Guests", sno: 3 });
  }
});

// --- Phase 2e step 1: reads, filters, counts and the overlap rule ---------------------------------------------

const OVERLAP_ID = "cbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("row 76: one assignment is read with its name; the staff list filters by role and branch; roles and templates carry counts", { skip }, async () => {
  stubPhase2cUsers();
  try {
    const viewerAssignment = await assignmentIdOf(PEOPLE.SELAM_VIEWER);
    const one = await as("SELAM_OWNER", "GET", `${staffBase()}/staff-assignments/${viewerAssignment}`);
    assert.deepEqual([one.status, one.body.data.id, one.body.data.role.code], [200, viewerAssignment, "VIEWER"]);
    assert.equal((await as("HORN_OWNER", "GET", `${staffBase()}/staff-assignments/${viewerAssignment}`)).status, 403, "another tenant");

    const roles = (await as("SELAM_OWNER", "GET", `${staffBase()}/roles`)).body.data as Array<{ id: string; code: string; grant_count: number; member_count: number }>;
    const viewerRole = roles.find((role) => role.code === "VIEWER");
    assert.ok(viewerRole);
    const members = await as("SELAM_OWNER", "GET", `${staffBase()}/staff-assignments?role_id=${viewerRole.id}&is_active=true`);
    assert.ok(members.body.data.every((row: { role: { code: string } }) => row.role.code === "VIEWER"));
    assert.equal(members.body.meta.count, viewerRole.member_count, "the role's member count matches its members");
    assert.equal(viewerRole.grant_count, 5, "Viewer gives view on five modules");

    const atAddis = await as("SELAM_OWNER", "GET", `${staffBase()}/staff-assignments?branch_id=${fixture.selamAddisBranchId}`);
    assert.ok(atAddis.body.data.length > 0 && atAddis.body.data.every((row: { branch: { id: string } | null }) => row.branch?.id === fixture.selamAddisBranchId));

    const templates = (await as("SUPER", "GET", "/v1/role-templates")).body.data as Array<{ code: string; grant_count: number }>;
    assert.equal(templates.find((template) => template.code === "OWNER")?.grant_count, 8, "seven modules, plus Payments since Phase 8");
  } finally {
    mock.restoreAll();
  }
});

test("row 77: the same role can't be held organization-wide and on a branch at once; several branches are fine", { skip }, async () => {
  mock.method(centralAuthClient, "findUserByMobile", async (mobile: string) =>
    mobile === "+251933000010" ? { userId: OVERLAP_ID, mobile, firstname: "Overlap", middlename: null, lastname: "Test" } : null,
  );
  mock.method(centralAuthClient, "getUsersByIds", async (ids: readonly string[]) =>
    ids.map((userId) => ({ userId, mobile: null, firstname: "Name", middlename: null, lastname: "Of Staff" })),
  );
  try {
    const roles = (await as("SELAM_OWNER", "GET", `${staffBase()}/roles`)).body.data as Array<{ id: string; code: string }>;
    const viewerRole = roles.find((role) => role.code === "VIEWER");
    assert.ok(viewerRole);
    const assignAt = (branchId?: string) =>
      as("SELAM_OWNER", "POST", `${staffBase()}/staff-assignments`, { mobile: "0933000010", role_id: viewerRole.id, ...(branchId ? { branch_id: branchId } : {}) });

    const atAddis = await assignAt(fixture.selamAddisBranchId);
    assert.equal(atAddis.status, 201, JSON.stringify(atAddis.body));
    const orgWide = await assignAt();
    assert.deepEqual([orgWide.status, orgWide.body.error.code], [409, "assignment_scope_conflict"]);
    const atMain = await assignAt(fixture.selamMainBranchId);
    assert.equal(atMain.status, 201, "several branches are fine");

    const moveToOrg = await as("SELAM_OWNER", "PATCH", `${staffBase()}/staff-assignments/${atMain.body.data.id}`, { branch_id: null });
    assert.deepEqual([moveToOrg.status, moveToOrg.body.error.code], [409, "assignment_scope_conflict"]);

    assert.equal((await as("SELAM_OWNER", "PATCH", `${staffBase()}/staff-assignments/${atAddis.body.data.id}/status`, { is_active: false })).status, 200);
    assert.equal((await as("SELAM_OWNER", "PATCH", `${staffBase()}/staff-assignments/${atMain.body.data.id}`, { branch_id: null })).status, 200);
    const backOn = await as("SELAM_OWNER", "PATCH", `${staffBase()}/staff-assignments/${atAddis.body.data.id}/status`, { is_active: true });
    assert.deepEqual([backOn.status, backOn.body.error.code], [409, "assignment_scope_conflict"], "switching on into an overlap is refused");
  } finally {
    mock.restoreAll();
  }
});

// --- Phase 2e step 2: all 7 actions, the grantable modules list, deleting assignments ---------------------------

test("row 78: an Owner gives a role Guests › delete and import; Organizations create and delete stay 400; nobody grants notify without holding it", { skip }, async () => {
  const given = await as("SELAM_OWNER", "PATCH", `${staffBase()}/roles/${roleFixture.helpersRoleId}`, {
    grants: [{ ...grantOf("REGISTRATIONS", true, false, false), delete: true, import: true }],
  });
  assert.equal(given.status, 200, JSON.stringify(given.body));
  const guests = given.body.data.grants.find((grant: { module_code: string }) => grant.module_code === "REGISTRATIONS");
  assert.deepEqual([guests.delete, guests.import, guests.notify], [true, true, false]);

  for (const box of ["create", "delete"] as const) {
    const refused = await as("SELAM_OWNER", "PATCH", `${staffBase()}/roles/${roleFixture.helpersRoleId}`, {
      grants: [{ ...grantOf("ORGANIZATIONS", true, false, false), [box]: true }],
    });
    assert.deepEqual([refused.status, refused.body.error.details.issues[0].path], [400, `body.grants.0.${box}`]);
  }

  const door = await tokenFor(DOOR_ID);
  const escalate = await asToken(door, "PATCH", `${staffBase()}/roles/${roleFixture.helpersRoleId}`, {
    grants: [{ ...grantOf("REGISTRATIONS", true, false, false), delete: true, import: true, notify: true }],
  });
  assert.deepEqual(
    [escalate.status, escalate.body.error.code, escalate.body.error.details],
    [403, "grant_exceeds_own_access", { module_code: "REGISTRATIONS", action: "notify" }],
    "keeping delete and import needs nothing; adding notify does",
  );
});

test("row 79: the migration gives existing Owners all 7 actions; the grantable modules list matches TENANT_GRANTABLE", { skip }, async () => {
  const events = await moduleRepository.findActivePermissionByCode("EVENTS");
  const organizations = await moduleRepository.findActivePermissionByCode("ORGANIZATIONS");
  assert.ok(events && organizations);
  const hornOwner = await Role.findOne({ where: { organization_id: fixture.hornId, code: "OWNER" }, raw: true });
  assert.ok(hornOwner);
  await RoleModuleAccess.update({ can_delete: false, can_notify: false }, { where: { role_id: hornOwner.id, module_id: events.id } });
  await grantAllActionsToOwnerRoles({ context: sequelize.getQueryInterface(), name: "all-actions", path: "" });
  const after = await RoleModuleAccess.findOne({ where: { role_id: hornOwner.id, module_id: events.id }, raw: true });
  assert.deepEqual([after?.can_delete, after?.can_import, after?.can_export, after?.can_notify], [true, true, true, true]);
  const onOrganizations = await RoleModuleAccess.findOne({ where: { role_id: hornOwner.id, module_id: organizations.id }, raw: true });
  assert.deepEqual([onOrganizations?.can_create, onOrganizations?.can_delete, onOrganizations?.can_notify], [false, false, true], "never create or delete");

  const ownerTemplate = await RoleTemplate.findOne({ where: { code: "OWNER" }, raw: true });
  assert.ok(ownerTemplate);
  const templateEvents = await RoleTemplateModuleAccess.findOne({ where: { role_template_id: ownerTemplate.id, module_id: events.id }, raw: true });
  assert.equal(templateEvents?.can_delete, true, "the OWNER template too, so new organizations' Owners hold all 7");

  const listed = await as("SELAM_OWNER", "GET", `${staffBase()}/grantable-modules`);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.deepEqual(
    Object.fromEntries((listed.body.data as Array<{ module_code: string; actions: string[] }>).map((module) => [module.module_code, module.actions])),
    Object.fromEntries(Object.entries(TENANT_GRANTABLE).map(([code, actions]) => [code, [...actions]])),
  );
  assert.equal((await asToken(await tokenFor(DOOR_ID), "GET", `${staffBase()}/grantable-modules`)).status, 200, "Staff Assignments › view is enough");
  assert.equal((await as("SELAM_VIEWER", "GET", `${staffBase()}/grantable-modules`)).status, 403);
});

test("row 80: deleting an assignment removes it and its overrides; the last Owner and your own are refused; a Viewer gets 403", { skip }, async () => {
  const overlapOrgWide = (await userRoleRepository.listAllByUser(OVERLAP_ID)).find((row) => row.is_active && row.branch_id === null);
  assert.ok(overlapOrgWide, "row 77 left an organization-wide assignment");
  const override = await as("SELAM_OWNER", "PUT", overridesOf(overlapOrgWide.id), { overrides: [{ module_code: "EVENTS", view: false }] });
  assert.equal(override.status, 200, JSON.stringify(override.body));
  assert.equal(await UserModuleAccess.count({ where: { user_role_id: overlapOrgWide.id } }), 1);

  assert.equal((await as("SELAM_VIEWER", "DELETE", `${staffBase()}/staff-assignments/${overlapOrgWide.id}`)).status, 403);
  const deleted = await as("SELAM_OWNER", "DELETE", `${staffBase()}/staff-assignments/${overlapOrgWide.id}`);
  assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
  assert.equal(await UserRole.count({ where: { id: overlapOrgWide.id } }), 0);
  assert.equal(await UserModuleAccess.count({ where: { user_role_id: overlapOrgWide.id } }), 0, "its overrides went with it");

  const own = await as("SELAM_OWNER", "DELETE", `${staffBase()}/staff-assignments/${await assignmentIdOf(PEOPLE.SELAM_OWNER)}`);
  assert.deepEqual([own.status, own.body.error.code], [409, "own_assignment"]);

  const abay = await Organization.findOne({ where: { name: "Abay Pilot" }, raw: true });
  assert.ok(abay);
  const lastOwner = await as("SUPER", "DELETE", `/v1/organizations/${abay.id}/staff-assignments/${await assignmentIdOf(ABAY_OWNER_ID)}`);
  assert.deepEqual([lastOwner.status, lastOwner.body.error.code], [409, "last_owner_assignment"]);
});

// --- Phase 2e step 3: a role remembers its template ------------------------------------------------------

test("row 81: a role made from a template copies its grants and remembers it; a switched-off template is refused; the Super Admin sees who uses it; template edits never reach the role", { skip }, async () => {
  const templateId = templateFixture.doorTemplateId;
  assert.ok(templateId, "row 73 made the Door helper template");
  const template = (await as("SUPER", "GET", `/v1/role-templates/${templateId}`)).body.data as {
    grants: Array<{ module_code: string; view: boolean; create: boolean; update: boolean }>;
  };

  const made = await as("SELAM_OWNER", "POST", `${staffBase()}/roles`, { code: "door_copy", name: "Door copy", role_template_id: templateId });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(made.body.data.role_template, { id: templateId, code: "DOOR_HELPER", name: "Door helper" });
  const shape = (grants: Array<{ module_code: string; view: boolean; create: boolean; update: boolean }>) =>
    grants.map((grant) => `${grant.module_code}:${grant.view}${grant.create}${grant.update}`).sort();
  assert.deepEqual(shape(made.body.data.grants), shape(template.grants), "the template's grants, copied");

  const filtered = await as("SELAM_OWNER", "GET", `${staffBase()}/roles?role_template_id=${templateId}`);
  assert.deepEqual(filtered.body.data.map((role: { code: string }) => role.code), ["DOOR_COPY"]);

  const usedBy = await as("SUPER", "GET", `/v1/role-templates/${templateId}/roles`);
  assert.ok(usedBy.body.data.some((role: { code: string; organization: { slug: string } }) => role.code === "DOOR_COPY" && role.organization.slug === "selam-events"));
  assert.equal((await as("SELAM_OWNER", "GET", `/v1/role-templates/${templateId}/roles`)).status, 403, "platform scope");

  assert.equal((await as("SUPER", "PATCH", `/v1/role-templates/${templateId}/status`, { is_active: false })).status, 200);
  try {
    const refused = await as("SELAM_OWNER", "POST", `${staffBase()}/roles`, { code: "door_late", name: "Door late", role_template_id: templateId });
    assert.deepEqual([refused.status, refused.body.error.code], [409, "role_template_inactive"]);
  } finally {
    assert.equal((await as("SUPER", "PATCH", `/v1/role-templates/${templateId}/status`, { is_active: true })).status, 200);
  }

  const edited = await as("SUPER", "PATCH", `/v1/role-templates/${templateId}`, { grants: [grantOf("CUSTOMERS", true, false, false)] });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const role = await as("SELAM_OWNER", "GET", `${staffBase()}/roles/${made.body.data.id}`);
  assert.deepEqual(shape(role.body.data.grants), shape(made.body.data.grants), "a copy, never a link");
});

// --- Phase 2e step 4: creating Cheche accounts when adding staff; editing names (auth-cheche stubbed) ------------

const NEW_ACCOUNT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccc01";
const RACED_ACCOUNT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccc02";

test("row 82: adding staff creates a Cheche account when the mobile has none; an existing account is used as it is; names are edited in auth-cheche, names only", { skip }, async () => {
  const accounts = new Map<string, { userId: string; firstname: string }>();
  let raceOnce = true;
  mock.method(centralAuthClient, "findUserByMobile", async (mobile: string) => {
    const found = accounts.get(mobile);
    return found ? { userId: found.userId, mobile, firstname: found.firstname, middlename: null, lastname: "Staff" } : null;
  });
  const create = mock.method(centralAuthClient, "createVerifiedUser", async (input: { mobile: string; firstname: string }) => {
    if (input.mobile === "+251933000021" && raceOnce) {
      // Someone made this account meanwhile: auth-cheche answers 409, and the lookup now finds it.
      raceOnce = false;
      accounts.set(input.mobile, { userId: RACED_ACCOUNT_ID, firstname: "Raced" });
      throw new ConflictError("User already exists");
    }
    accounts.set(input.mobile, { userId: NEW_ACCOUNT_ID, firstname: input.firstname });
    return { userId: NEW_ACCOUNT_ID, mobile: input.mobile, firstname: input.firstname, middlename: null, lastname: "Staff" };
  });
  const rename = mock.method(centralAuthClient, "updateUserProfile", async (_id: string, _patch: unknown) => undefined);
  mock.method(centralAuthClient, "getUserProfile", async (userId: string) => ({ userId, mobile: null, firstname: "Liya", middlename: null, lastname: "Staff", email: null, sex: null, date_of_birth: null }));
  mock.method(centralAuthClient, "getUsersByIds", async (ids: readonly string[]) =>
    ids.map((userId) => ({ userId, mobile: null, firstname: "Name", middlename: null, lastname: "Of Staff" })),
  );
  try {
    const roles = (await as("SELAM_OWNER", "GET", `${staffBase()}/roles`)).body.data as Array<{ id: string; code: string }>;
    const viewerRole = roles.find((role) => role.code === "VIEWER");
    assert.ok(viewerRole);

    const unknown = await as("SELAM_OWNER", "POST", `${staffBase()}/staff-assignments`, { mobile: "0933000020", role_id: viewerRole.id });
    assert.deepEqual([unknown.status, unknown.body.error.code], [404, "central_account_not_found"], "no new_account: as before");

    const created = await as("SELAM_OWNER", "POST", `${staffBase()}/staff-assignments`, {
      mobile: "0933000020",
      role_id: viewerRole.id,
      new_account: { firstname: "Liya", lastname: "Staff", password: "first-pass-1" },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual([created.body.data.account_created, created.body.data.user_id], [true, NEW_ACCOUNT_ID]);
    assert.ok(!JSON.stringify(created.body).includes("first-pass-1"), "the password is never returned");
    assert.equal((create.mock.calls[0]?.arguments[0] as { password: string }).password, "first-pass-1");

    const raced = await as("SELAM_OWNER", "POST", `${staffBase()}/staff-assignments`, {
      mobile: "0933000021",
      role_id: viewerRole.id,
      new_account: { firstname: "Abel", lastname: "Staff", password: "second-pass" },
    });
    assert.equal(raced.status, 201, JSON.stringify(raced.body));
    assert.deepEqual([raced.body.data.account_created, raced.body.data.user_id], [false, RACED_ACCOUNT_ID], "409: the existing account is used");

    const path = `${staffBase()}/staff-assignments/${created.body.data.id}/profile`;
    const renamed = await as("SELAM_OWNER", "PATCH", path, { firstname: "Liyu", lastname: "Bekele" });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.deepEqual(rename.mock.calls[0]?.arguments, [NEW_ACCOUNT_ID, { firstname: "Liyu", lastname: "Bekele" }]);
    assert.equal((await as("SELAM_OWNER", "PATCH", path, { mobile: "0933000099" })).status, 400, "never the mobile");
    assert.equal((await as("SELAM_VIEWER", "PATCH", path, { firstname: "X" })).status, 403);
    const abay = await Organization.findOne({ where: { name: "Abay Pilot" }, raw: true });
    assert.ok(abay);
    const fromAbay = await asToken(await tokenFor(ABAY_OWNER_ID), "PATCH", path.replace(fixture.selamId, abay.id), { firstname: "X" });
    assert.equal(fromAbay.status, 404, "another organization's assignment isn't found there");
  } finally {
    mock.restoreAll();
  }
});

// --- Phase 2e step 5: platform roles and platform staff ------------------------------------------------------

const SUPPORT_ID = "cddddddd-dddd-4ddd-8ddd-dddddddddd01";
const platformFixture = { supportRoleId: "", supportAssignmentId: "" };

function stubPlatformPeople() {
  const people: Record<string, string> = { "+251933000030": SUPPORT_ID, "+251933000031": PEOPLE.SELAM_VIEWER };
  mock.method(centralAuthClient, "findUserByMobile", async (mobile: string) => {
    const userId = people[mobile];
    return userId ? { userId, mobile, firstname: "Platform", middlename: null, lastname: "Person" } : null;
  });
  mock.method(centralAuthClient, "getUsersByIds", async (ids: readonly string[]) =>
    ids.map((userId) => ({ userId, mobile: null, firstname: "Name", middlename: null, lastname: "Of Staff" })),
  );
}

test("row 83: the Super Admin creates Platform support and assigns someone; they read guests in two organizations, can't create events, and /me shows their menu", { skip }, async () => {
  stubPlatformPeople();
  try {
    const role = await as("SUPER", "POST", "/v1/platform/roles", {
      code: "platform_support",
      name: "Platform support",
      grants: [grantOf("ORGANIZATIONS", true, false, false), grantOf("REGISTRATIONS", true, false, false)],
    });
    assert.equal(role.status, 201, JSON.stringify(role.body));
    platformFixture.supportRoleId = role.body.data.id;

    const given = await as("SUPER", "POST", "/v1/platform/staff-assignments", { mobile: "0933000030", role_id: platformFixture.supportRoleId });
    assert.equal(given.status, 201, JSON.stringify(given.body));
    platformFixture.supportAssignmentId = given.body.data.id;
    assert.equal((await as("SUPER", "GET", "/v1/platform/staff-assignments")).body.data.some((row: { id: string }) => row.id === given.body.data.id), true);

    const support = await tokenFor(SUPPORT_ID);
    assert.equal((await asToken(support, "GET", swapFixture.guestsPath)).status, 200, "Selam's guests");
    const abayEvent = await AppEvent.findOne({ where: { organization_id: guestFixturePhase6.abayId, slug: guestFixturePhase6.abayDaySlug }, raw: true });
    assert.ok(abayEvent);
    assert.equal((await asToken(support, "GET", `/v1/organizations/${guestFixturePhase6.abayId}/events/${abayEvent.id}/registrations`)).status, 200, "Abay's guests");
    assert.equal((await asToken(support, "POST", `/v1/organizations/${fixture.selamId}/events`, { name: "Support Party" })).status, 403);

    const me = await asToken(support, "GET", "/v1/auth/staff/me");
    assert.equal(me.status, 200, JSON.stringify(me.body));
    const codes = (me.body.data.navigation as Array<{ children: Array<{ code: string }> }>).flatMap((node) => node.children.map((child) => child.code));
    assert.ok(codes.includes("REGISTRATIONS") && codes.includes("ORGANIZATIONS"), JSON.stringify(codes));
    assert.equal(me.body.data.permissions.EVENTS.create, false);
  } finally {
    mock.restoreAll();
  }
});

test("row 84: Owners can't reach platform routes or see platform rows; SUPER_ADMIN is locked; the last Super Admin stays; tenant staff can't be platform staff", { skip }, async () => {
  stubPlatformPeople();
  try {
    assert.equal((await as("SELAM_OWNER", "GET", "/v1/platform/roles")).status, 403);
    assert.equal((await as("SELAM_OWNER", "POST", "/v1/platform/roles", { code: "X", name: "X", grants: [] })).status, 403);
    assert.equal((await as("SELAM_OWNER", "GET", "/v1/platform/staff-assignments")).status, 403);
    const selamRoles = (await as("SELAM_OWNER", "GET", `${staffBase()}/roles`)).body.data as Array<{ code: string }>;
    assert.ok(!selamRoles.some((role) => role.code === "PLATFORM_SUPPORT" || role.code === "SUPER_ADMIN"), "tenant lists never show platform roles");
    assert.equal((await as("SELAM_OWNER", "GET", `${staffBase()}/staff-assignments/${platformFixture.supportAssignmentId}`)).status, 404, "nor platform staff");

    const superRole = (await as("SUPER", "GET", "/v1/platform/roles")).body.data.find((role: { code: string }) => role.code === "SUPER_ADMIN");
    const locked = await as("SUPER", "PATCH", `/v1/platform/roles/${superRole.id}`, { name: "Boss" });
    assert.deepEqual([locked.status, locked.body.error.code], [409, "role_locked"]);

    // Platform support may now manage platform staff, so the last-Super-Admin rule can be tried by someone else.
    const widened = await as("SUPER", "PATCH", `/v1/platform/roles/${platformFixture.supportRoleId}`, {
      grants: [
        grantOf("ORGANIZATIONS", true, false, false),
        grantOf("REGISTRATIONS", true, false, false),
        { ...grantOf("USER_ROLES", true, false, true), delete: true },
      ],
    });
    assert.equal(widened.status, 200, JSON.stringify(widened.body));
    const support = await tokenFor(SUPPORT_ID);
    const superAssignment = await assignmentIdOf(PEOPLE.SUPER);
    const off = await asToken(support, "PATCH", `/v1/platform/staff-assignments/${superAssignment}/status`, { is_active: false });
    assert.deepEqual([off.status, off.body.error.code], [409, "last_super_admin"]);
    const gone = await asToken(support, "DELETE", `/v1/platform/staff-assignments/${superAssignment}`);
    assert.deepEqual([gone.status, gone.body.error.code], [409, "last_super_admin"]);
    const own = await as("SUPER", "DELETE", `/v1/platform/staff-assignments/${superAssignment}`);
    assert.deepEqual([own.status, own.body.error.code], [409, "own_assignment"]);

    const tenantPerson = await as("SUPER", "POST", "/v1/platform/staff-assignments", { mobile: "0933000031", role_id: platformFixture.supportRoleId });
    assert.deepEqual([tenantPerson.status, tenantPerson.body.error.code, tenantPerson.body.error.details.field], [409, "conflict", "user_id"]);
  } finally {
    mock.restoreAll();
  }
});

// --- Phase 2e step 6: module administration and feature gates ----------------------------------------------

type ModuleNode = { id: string; code: string; is_active: boolean; parent_id: string | null; children: ModuleNode[] };

/** Every module by code, from the Super Admin's tree (switched-off ones included). */
async function modulesByCode(): Promise<Map<string, ModuleNode>> {
  const tree = (await as("SUPER", "GET", "/v1/modules")).body.data as ModuleNode[];
  const flat = (nodes: ModuleNode[]): ModuleNode[] => nodes.flatMap((node) => [node, ...flat(node.children)]);
  return new Map(flat(tree).map((node) => [node.code, node]));
}

const moduleIdOf = (modules: Map<string, ModuleNode>, code: string): string => {
  const found = modules.get(code);
  assert.ok(found, `module ${code}`);
  return found.id;
};

test("row 85: the Super Admin builds a menu group with a link and a permission module; /me shows the tree; loops, core routes and granted modules are refused; new modules aren't tenant-grantable", { skip }, async () => {
  stubPlatformPeople();
  try {
    const group = await as("SUPER", "POST", "/v1/modules", { code: "insights", module_name: "Insights", is_menu: true, is_permission: false, sno: 90, icon: "ChartBar" });
    assert.equal(group.status, 201, JSON.stringify(group.body));
    assert.deepEqual([group.body.data.code, group.body.data.is_core, group.body.data.always_on], ["INSIGHTS", false, false]);
    const link = await as("SUPER", "POST", "/v1/modules", {
      code: "SALES_DASHBOARD",
      module_name: "Sales dashboard",
      parent_id: group.body.data.id,
      route_name: "/insights/sales",
      is_menu: true,
      is_permission: false,
    });
    assert.equal(link.status, 201, JSON.stringify(link.body));
    const report = await as("SUPER", "POST", "/v1/modules", { code: "SALES_REPORT", module_name: "Sales report", route_name: "/insights/report", is_menu: true, is_permission: true });
    assert.equal(report.status, 201, JSON.stringify(report.body));
    assert.equal((await as("SUPER", "POST", "/v1/modules", { code: "SALES_REPORT", module_name: "Again", is_menu: true, is_permission: true })).status, 409, "codes are unique");

    // Move the permission module under the group; /me shows the new tree.
    const moved = await as("SUPER", "PATCH", `/v1/modules/${report.body.data.id}`, { parent_id: group.body.data.id, sno: 2 });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const me = await as("SUPER", "GET", "/v1/auth/staff/me");
    const insights = (me.body.data.navigation as Array<{ code: string; children: Array<{ code: string }> }>).find((node) => node.code === "INSIGHTS");
    assert.deepEqual(insights?.children.map((child) => child.code), ["SALES_DASHBOARD", "SALES_REPORT"]);
    assert.equal(me.body.data.permissions.SALES_REPORT.view, true);

    // A loop is 400; a core module's route is fixed.
    const loop = await as("SUPER", "PATCH", `/v1/modules/${group.body.data.id}`, { parent_id: report.body.data.id });
    assert.deepEqual([loop.status, loop.body.error.details.issues[0].code], [400, "parent_cycle"]);
    const modules = await modulesByCode();
    const coreRoute = await as("SUPER", "PATCH", `/v1/modules/${moduleIdOf(modules, "EVENTS")}`, { route_name: "/programs" });
    assert.deepEqual([coreRoute.status, coreRoute.body.error.code], [409, "module_protected"]);

    // A platform role may hold the new permission module; an organization's role may not.
    const support = await as("SUPER", "PATCH", `/v1/platform/roles/${platformFixture.supportRoleId}`, {
      grants: [
        grantOf("ORGANIZATIONS", true, false, false),
        grantOf("REGISTRATIONS", true, false, false),
        { ...grantOf("USER_ROLES", true, false, true), delete: true },
        grantOf("SALES_REPORT", true, false, false),
      ],
    });
    assert.equal(support.status, 200, JSON.stringify(support.body));
    const tenant = await as("SELAM_OWNER", "POST", `${staffBase()}/roles`, { code: "ANALYST", name: "Analyst", grants: [grantOf("SALES_REPORT", true, false, false)] });
    assert.deepEqual([tenant.status, tenant.body.error.details.issues[0].code], [400, "module_not_grantable"]);

    // While a role grants it, it stays a permission module.
    const inUse = await as("SUPER", "PATCH", `/v1/modules/${report.body.data.id}`, { is_permission: false });
    assert.deepEqual([inUse.status, inUse.body.error.code, inUse.body.error.details.grants], [409, "module_in_use", 1]);

    // Tidy up: a group with switched-on submodules can't be switched off; switch them off first.
    const groupFirst = await as("SUPER", "PATCH", `/v1/modules/${group.body.data.id}/status`, { is_active: false });
    assert.deepEqual([groupFirst.status, groupFirst.body.error.code, groupFirst.body.error.details.active_children], [409, "invalid_module_state", 2]);
    for (const id of [link.body.data.id, report.body.data.id, group.body.data.id]) {
      assert.equal((await as("SUPER", "PATCH", `/v1/modules/${id}/status`, { is_active: false })).status, 200);
    }
    const after = await as("SUPER", "GET", "/v1/auth/staff/me");
    assert.ok(!(after.body.data.navigation as Array<{ code: string }>).some((node) => node.code === "INSIGHTS"), "switched off, it leaves the menu");
  } finally {
    mock.restoreAll();
  }
});

test("row 86: switching Guests off denies everyone and keeps its grants; Modules stays on; without branches, Branches is feature_disabled but adding one stays open", { skip }, async () => {
  stubPlatformPeople();
  try {
    const modules = await modulesByCode();
    const protectedOff = await as("SUPER", "PATCH", `/v1/modules/${moduleIdOf(modules, "MODULES")}/status`, { is_active: false });
    assert.deepEqual([protectedOff.status, protectedOff.body.error.code], [409, "module_protected"]);

    const guests = moduleIdOf(modules, "REGISTRATIONS");
    const off = await as("SUPER", "PATCH", `/v1/modules/${guests}/status`, { is_active: false });
    assert.deepEqual([off.status, off.body.data.is_active], [200, false]);
    let newOrganizationId = "";
    try {
      for (const person of ["SELAM_OWNER", "SUPER"] as const) {
        const denied = await as(person, "GET", swapFixture.guestsPath);
        assert.deepEqual([denied.status, denied.body.error.details], [403, { reason: "module_unavailable" }], `${person}: the Super Admin included`);
      }
      const me = await as("SELAM_OWNER", "GET", "/v1/auth/staff/me");
      assert.equal(me.body.data.permissions.REGISTRATIONS, undefined);
      const codes = (me.body.data.navigation as Array<{ code: string; children: Array<{ code: string }> }>).flatMap((node) => [node.code, ...node.children.map((child) => child.code)]);
      assert.ok(!codes.includes("REGISTRATIONS"), JSON.stringify(codes));

      // Editing a role while Guests is off: the form doesn't show Guests, and its grant is kept.
      const edited = await as("SUPER", "PATCH", `/v1/platform/roles/${platformFixture.supportRoleId}`, {
        grants: [grantOf("ORGANIZATIONS", true, false, false), { ...grantOf("USER_ROLES", true, false, true), delete: true }],
      });
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      assert.ok(!(edited.body.data.grants as Array<{ module_code: string }>).some((grant) => grant.module_code === "REGISTRATIONS"));

      // A new organization while Guests is off still gets its Owner's Guests grant (for when it is back on).
      const created = await as("SUPER", "POST", "/v1/organizations", { organization: { name: "Blue Nile Pilot" } });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      newOrganizationId = created.body.data.organization.id;
    } finally {
      assert.equal((await as("SUPER", "PATCH", `/v1/modules/${guests}/status`, { is_active: true })).status, 200);
    }
    const supportToken = await tokenFor(SUPPORT_ID);
    assert.equal((await asToken(supportToken, "GET", swapFixture.guestsPath)).status, 200, "the kept grant works again");
    const roles = (await as("SUPER", "GET", `/v1/organizations/${newOrganizationId}/roles`)).body.data as Array<{ code: string; grants: Array<{ module_code: string }> }>;
    assert.ok(roles.find((role) => role.code === "OWNER")?.grants.some((grant) => grant.module_code === "REGISTRATIONS"));

    // Abay Pilot (row 62) has no branches: its Owner may only add the first one (row 21 shows that switching them on).
    const abay = await Organization.findOne({ where: { name: "Abay Pilot" }, raw: true });
    assert.ok(abay);
    assert.equal(abay.has_branches, false);
    const abayOwner = await tokenFor(ABAY_OWNER_ID);
    const list = await asToken(abayOwner, "GET", `/v1/organizations/${abay.id}/branches`);
    assert.deepEqual([list.status, list.body.error.details], [403, { reason: "feature_disabled" }]);
    const abayMe = await asToken(abayOwner, "GET", "/v1/auth/staff/me");
    assert.deepEqual(abayMe.body.data.permissions.BRANCHES, { view: false, create: true, update: false, delete: false, import: false, export: false, notify: false });
    assert.equal((await as("SUPER", "GET", `/v1/organizations/${abay.id}/branches`)).status, 200, "the Super Admin is exempt");
  } finally {
    mock.restoreAll();
  }
});

// --- Phase 7 step 1: prices, audiences and holder fields ----------------------------------------------------

const festivalFixture = { eventId: "", path: "", publicPath: "", gaId: "", vipId: "", crewId: "" };
const festivalForm = (extra: Record<string, unknown> = {}) => ({ ...workshopForm("Hana", "0913000001"), ...extra });

test("row 87: checkout settings round-trip; a staff-only type is invisible to the public and refused by code; staff can issue it", { skip }, async () => {
  resetPublicLimit();
  const selamEvents = `/v1/organizations/${fixture.selamId}/events`;
  const created = await as("SELAM_OWNER", "POST", selamEvents, {
    name: "Coffee Festival",
    starts_at: "2027-06-01T07:00:00+03:00",
    ends_at: "2027-06-01T18:00:00+03:00",
    registration_mode: "QUICK",
    purchase_limit_per_mobile: 4,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual([created.body.data.registration_mode, created.body.data.purchase_limit_per_mobile, created.body.data.holder_fields.name], ["QUICK", 4, "REQUIRED"]);
  festivalFixture.eventId = created.body.data.id;
  festivalFixture.path = `${selamEvents}/${festivalFixture.eventId}`;
  festivalFixture.publicPath = `/v1/public/organizations/selam-events/events/${created.body.data.slug}`;

  const types = await as("SELAM_OWNER", "GET", `${festivalFixture.path}/ticket-types`);
  const ga = types.body.data[0];
  assert.deepEqual([ga.code, ga.price, ga.currency, ga.audience], ["GA", "0.00", "ETB", "PUBLIC"], "General Admission is free and public");
  festivalFixture.gaId = ga.id;
  const vip = await as("SELAM_OWNER", "POST", `${festivalFixture.path}/ticket-types`, { code: "VIP", name: "VIP", price: "1000" });
  assert.deepEqual([vip.status, vip.body.data.price], [201, "1000.00"]);
  festivalFixture.vipId = vip.body.data.id;
  const crew = await as("SELAM_OWNER", "POST", `${festivalFixture.path}/ticket-types`, { code: "CREW", name: "Crew", audience: "STAFF_ONLY" });
  assert.deepEqual([crew.status, crew.body.data.audience], [201, "STAFF_ONLY"]);
  festivalFixture.crewId = crew.body.data.id;
  assert.equal((await as("SELAM_OWNER", "PATCH", `${festivalFixture.path}/status`, { status: "PUBLISHED" })).status, 200);

  const page = await publicGet(festivalFixture.publicPath);
  assert.equal(page.status, 200);
  assert.deepEqual(
    page.body.data.ticket_types.map((type: { code: string; price: string; is_free: boolean }) => [type.code, type.price, type.is_free]),
    [
      ["GA", "0.00", true],
      ["VIP", "1000.00", false],
    ],
  );
  assert.deepEqual([page.body.data.registration_mode, page.body.data.purchase_limit_per_mobile, page.body.data.registration_open], ["QUICK", 4, true]);

  const byCode = await postWithKey(`${festivalFixture.publicPath}/registrations`, festivalForm({ ticket_type_code: "CREW" }), randomUUID());
  assert.deepEqual([byCode.status, byCode.body.error.code], [404, "not_found"]);

  const staffIssued = await as("SELAM_OWNER", "POST", `${festivalFixture.path}/registrations`, {
    person: { first_name: "Dawit", last_name: "Crew", phone: "0913000002" },
    ticket_type_id: festivalFixture.crewId,
  });
  assert.equal(staffIssued.status, 201, JSON.stringify(staffIssued.body));
});

test("row 88: a paid type can't be had through the old endpoints; a DETAILED event's fields are enforced; only staff-only types close the event; old events are unchanged", { skip }, async () => {
  resetPublicLimit();
  const registrations = `${festivalFixture.publicPath}/registrations`;
  const paidPublic = await postWithKey(registrations, festivalForm({ ticket_type_code: "VIP" }), randomUUID());
  assert.deepEqual([paidPublic.status, paidPublic.body.error.code, paidPublic.body.error.details.price], [409, "payment_required", "1000.00"]);
  const paidStaff = await as("SELAM_OWNER", "POST", `${festivalFixture.path}/registrations`, {
    person: { first_name: "Meron", last_name: "Paid", phone: "0913000003" },
    ticket_type_id: festivalFixture.vipId,
  });
  assert.deepEqual([paidStaff.status, paidStaff.body.error.code], [409, "payment_required"]);

  // DETAILED with email required and affiliation hidden.
  const detailed = await as("SELAM_OWNER", "PATCH", festivalFixture.path, {
    registration_mode: "DETAILED",
    holder_fields: { name: "REQUIRED", mobile: "REQUIRED", email: "REQUIRED", affiliation: "HIDDEN", country: "OPTIONAL" },
  });
  assert.equal(detailed.status, 200, JSON.stringify(detailed.body));
  const missing = await postWithKey(registrations, festivalForm({ ticket_type_code: "GA", affiliation_name: "Selam Bank" }), randomUUID());
  assert.equal(missing.status, 400);
  assert.deepEqual(
    missing.body.error.details.issues.map((issue: { path: string; code: string }) => [issue.path, issue.code]),
    [
      ["body.email", "required"],
      ["body.affiliation_name", "not_collected"],
    ],
  );
  const complete = await postWithKey(registrations, festivalForm({ ticket_type_code: "GA", email: "hana@example.com" }), randomUUID());
  assert.equal(complete.status, 201, JSON.stringify(complete.body));

  // Only the staff-only type left active: closed to the public, on the page and on the form.
  assert.equal((await as("SELAM_OWNER", "PATCH", `${festivalFixture.path}/ticket-types/${festivalFixture.gaId}/status`, { is_active: false })).status, 200);
  assert.equal((await as("SELAM_OWNER", "PATCH", `${festivalFixture.path}/ticket-types/${festivalFixture.vipId}/status`, { is_active: false })).status, 200);
  assert.equal((await publicGet(festivalFixture.publicPath)).body.data.registration_open, false);
  const closed = await postWithKey(registrations, festivalForm({ email: "liya@example.com", phone: "0913000004" }), randomUUID());
  assert.deepEqual([closed.status, closed.body.error.code, closed.body.error.details.reason], [409, "registration_closed", "NO_PUBLIC_TICKETS"]);

  // An event from before Phase 7 keeps today's form and free, public ticket types.
  const workshop = await publicGet("/v1/public/organizations/selam-events/events/partner-workshop");
  assert.equal(workshop.body.data.registration_mode, "DETAILED");
  assert.deepEqual(workshop.body.data.holder_fields, { name: "REQUIRED", mobile: "REQUIRED", email: "OPTIONAL", affiliation: "OPTIONAL", country: "OPTIONAL" });
  assert.ok(workshop.body.data.ticket_types.every((type: { price: string; is_free: boolean }) => type.price === "0.00" && type.is_free));
});

// --- Phase 7 step 2: orders, group checkout and the purchase limit -----------------------------------------------

const checkoutFixture = { quickId: "", quickPath: "", quickPublic: "", quickGaId: "", quickCrewId: "", hanaOrderTickets: [] as Array<{ code: string }> };
const orderForm = (items: unknown[], buyer_mobile?: string) => ({ ...(buyer_mobile ? { buyer_mobile } : {}), privacy_notice_version: PRIVACY_NOTICE_VERSION, items });

/** A published Selam event for checkout rows, with General Admission (and any extra ticket types). */
async function publishedCheckoutEvent(body: Record<string, unknown>, extraTypes: Array<Record<string, unknown>> = []) {
  const selamEvents = `/v1/organizations/${fixture.selamId}/events`;
  const created = await as("SELAM_OWNER", "POST", selamEvents, { starts_at: "2027-07-01T07:00:00+03:00", ends_at: "2027-07-01T18:00:00+03:00", ...body });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const path = `${selamEvents}/${created.body.data.id}`;
  const types: Record<string, string> = { GA: (await as("SELAM_OWNER", "GET", `${path}/ticket-types`)).body.data[0].id };
  for (const type of extraTypes) {
    const added = await as("SELAM_OWNER", "POST", `${path}/ticket-types`, type);
    assert.equal(added.status, 201, JSON.stringify(added.body));
    types[added.body.data.code] = added.body.data.id;
  }
  assert.equal((await as("SELAM_OWNER", "PATCH", `${path}/status`, { status: "PUBLISHED" })).status, 200);
  return { id: created.body.data.id as string, path, publicPath: `/v1/public/organizations/selam-events/events/${created.body.data.slug}`, types };
}

test("row 89: Hana gets 3 quick tickets with one mobile; a retry returns the same codes; 2 more break the limit of 4; 1 more in another format is fine", { skip }, async () => {
  resetPublicLimit();
  const event = await publishedCheckoutEvent({ name: "Harvest Festival", registration_mode: "QUICK", purchase_limit_per_mobile: 4 }, [{ code: "CREW", name: "Crew", audience: "STAFF_ONLY" }]);
  Object.assign(checkoutFixture, { quickId: event.id, quickPath: event.path, quickPublic: event.publicPath, quickGaId: event.types.GA, quickCrewId: event.types.CREW });
  const orders = `${event.publicPath}/orders`;

  const key = randomUUID();
  const first = await postWithKey(orders, orderForm([{ ticket_type_code: "GA", quantity: 3 }], "0913100001"), key);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const codes = first.body.data.tickets.map((ticket: { code: string }) => ticket.code);
  assert.equal(new Set(codes).size, 3, "three distinct codes");
  assert.ok(first.body.data.tickets.every((ticket: { holder: unknown }) => ticket.holder === null), "quick tickets are unnamed");
  assert.equal(first.body.data.total_amount, "0.00");
  checkoutFixture.hanaOrderTickets = first.body.data.tickets;

  const again = await postWithKey(orders, orderForm([{ ticket_type_code: "GA", quantity: 3 }], "0913100001"), key);
  assert.deepEqual([again.status, again.body.data.tickets.map((ticket: { code: string }) => ticket.code)], [200, codes]);

  const tooMany = await postWithKey(orders, orderForm([{ ticket_type_code: "GA", quantity: 2 }], "0913100001"), randomUUID());
  assert.deepEqual([tooMany.status, tooMany.body.error.code, tooMany.body.error.details], [409, "purchase_limit_reached", { limit: 4, held: 3, requested: 2 }]);
  const oneMore = await postWithKey(orders, orderForm([{ ticket_type_code: "GA", quantity: 1 }], "+251913100001"), randomUUID());
  assert.equal(oneMore.status, 201, JSON.stringify(oneMore.body));
  const fifth = await postWithKey(orders, orderForm([{ ticket_type_code: "GA", quantity: 1 }], "0913 100 001"), randomUUID());
  assert.equal(fifth.body.error?.code, "purchase_limit_reached", "the same mobile written a third way");

  // One SMS per order, to the buyer, listing every code.
  const order = await TicketOrder.findOne({ where: { reference: first.body.data.reference }, raw: true });
  assert.ok(order);
  const messages = await MessageOutbox.findAll({ where: { order_id: order.id }, raw: true });
  assert.deepEqual(
    // Compared as a set: tickets made in the same millisecond come back in code order, the SMS lists creation order.
    messages.map((message) => [message.kind, message.recipient, "codes" in message.payload ? [...message.payload.codes].sort() : null]),
    [["ORDER_CONFIRMATION", "+251913100001", [...codes].sort()]],
  );
  assert.equal(await Registration.count({ where: { order_id: order.id } }), 3);
});

test("row 90: a detailed training needs each attendee's name and affiliation; a missing answer names the holder and takes no place; a complete order lists 3 named guests", { skip }, async () => {
  resetPublicLimit();
  const event = await publishedCheckoutEvent({
    name: "Credit Training",
    registration_mode: "DETAILED",
    holder_fields: { name: "REQUIRED", mobile: "OPTIONAL", email: "OPTIONAL", affiliation: "REQUIRED", country: "HIDDEN" },
  });
  const orders = `${event.publicPath}/orders`;
  const holders = [
    { first_name: "Hana", last_name: "Bekele", affiliation_name: "Selam Bank" },
    { first_name: "Abel", last_name: "Tadesse" },
    { first_name: "Liya", last_name: "Tesfaye", affiliation_name: "Horn NGO" },
  ];
  const missing = await postWithKey(orders, orderForm([{ ticket_type_code: "GA", quantity: 3, holders }], "0913100002"), randomUUID());
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.body.error.details.issues.map((issue: { path: string; code: string }) => [issue.path, issue.code]), [["body.items.0.holders.1.affiliation_name", "required"]]);
  assert.equal(await Registration.count({ where: { event_id: event.id } }), 0, "no place taken");

  const complete = await postWithKey(
    orders,
    orderForm([{ ticket_type_code: "GA", quantity: 3, holders: holders.map((holder) => ({ affiliation_name: "Selam Bank", ...holder })) }], "0913100002"),
    randomUUID(),
  );
  assert.equal(complete.status, 201, JSON.stringify(complete.body));
  const list = await as("SELAM_OWNER", "GET", `${event.path}/registrations`);
  assert.deepEqual(
    list.body.data.map((row: { person: { first_name: string; affiliation_name: string }; order: { reference: string } }) => [row.person.first_name, row.person.affiliation_name, row.order.reference]).sort(),
    [
      ["Abel", "Selam Bank", complete.body.data.reference],
      ["Hana", "Selam Bank", complete.body.data.reference],
      ["Liya", "Horn NGO", complete.body.data.reference],
    ],
  );
});

test("row 91: the last place goes to one of two racing orders; one mobile racing itself keeps the combined limit; only staff issue a staff-only type; another tenant can't reach orders", { skip }, async () => {
  resetPublicLimit();
  const last = await publishedCheckoutEvent({ name: "Rooftop Dinner", registration_mode: "QUICK", capacity: 1 });
  const race = await Promise.all([
    postWithKey(`${last.publicPath}/orders`, orderForm([{ ticket_type_code: "GA", quantity: 1 }], "0913100003"), randomUUID()),
    postWithKey(`${last.publicPath}/orders`, orderForm([{ ticket_type_code: "GA", quantity: 1 }], "0913100004"), randomUUID()),
  ]);
  assert.deepEqual(race.map((response) => response.status).sort(), [201, 409]);
  assert.equal(race.find((response) => response.status === 409)?.body.error.code, "capacity_reached");
  assert.equal(await Registration.count({ where: { event_id: last.id, status: "CONFIRMED" } }), 1);

  const limited = await publishedCheckoutEvent({ name: "Book Fair", registration_mode: "QUICK", purchase_limit_per_mobile: 2 });
  const sameMobile = await Promise.all([
    postWithKey(`${limited.publicPath}/orders`, orderForm([{ ticket_type_code: "GA", quantity: 2 }], "0913100005"), randomUUID()),
    postWithKey(`${limited.publicPath}/orders`, orderForm([{ ticket_type_code: "GA", quantity: 2 }], "+251913100005"), randomUUID()),
  ]);
  assert.deepEqual(sameMobile.map((response) => response.status).sort(), [201, 409]);
  assert.equal(await Registration.count({ where: { event_id: limited.id, status: "CONFIRMED" } }), 2);

  const crewByPublic = await postWithKey(`${checkoutFixture.quickPublic}/orders`, orderForm([{ ticket_type_code: "CREW", quantity: 1 }], "0913100006"), randomUUID());
  assert.equal(crewByPublic.status, 404);
  // The festival has a limit of 4 per mobile (row 89), so since Phase 8 even staff tickets need a buyer mobile.
  const crewNoMobile = await as("SELAM_OWNER", "POST", `${checkoutFixture.quickPath}/orders`, { items: [{ ticket_type_id: checkoutFixture.quickCrewId, quantity: 2 }] });
  assert.deepEqual([crewNoMobile.status, crewNoMobile.body.error.details.issues[0].code], [400, "buyer_mobile_required"]);
  const crewByStaff = await as("SELAM_OWNER", "POST", `${checkoutFixture.quickPath}/orders`, { buyer_mobile: "0913100007", items: [{ ticket_type_id: checkoutFixture.quickCrewId, quantity: 2 }] });
  assert.deepEqual([crewByStaff.status, crewByStaff.body.data.ticket_count, crewByStaff.body.data.buyer_mobile], [201, 2, "+251913100007"]);

  const abay = await Organization.findOne({ where: { name: "Abay Pilot" }, raw: true });
  assert.ok(abay);
  assert.equal((await as("SELAM_OWNER", "GET", `/v1/organizations/${abay.id}/events/${randomUUID()}/orders`)).status, 403);
  assert.equal((await as("SELAM_VIEWER", "POST", `${checkoutFixture.quickPath}/orders`, { items: [{ ticket_type_id: checkoutFixture.quickGaId, quantity: 1 }] })).status, 403);
  const listed = await as("SELAM_VIEWER", "GET", `${checkoutFixture.quickPath}/orders?buyer_mobile=0913100001`);
  assert.deepEqual([listed.status, listed.body.data.length], [200, 2], "a viewer reads orders; Hana has two");
});

test("row 92: cancelling a ticket frees its place and allowance; the guest list and CSV show unnamed tickets; My Tickets shows tickets an account bought", { skip }, async () => {
  resetPublicLimit();
  resetGuestLimits();
  // Hana holds 4 at the Harvest Festival (row 89): cancelling one lets her get one more.
  const [first] = checkoutFixture.hanaOrderTickets;
  assert.ok(first);
  const ticket = await Registration.findOne({ where: { code: first.code }, raw: true });
  assert.ok(ticket);
  assert.equal((await as("SELAM_OWNER", "PATCH", `${checkoutFixture.quickPath}/registrations/${ticket.id}/status`, { status: "CANCELLED" })).status, 200);
  const again = await postWithKey(`${checkoutFixture.quickPublic}/orders`, orderForm([{ ticket_type_code: "GA", quantity: 1 }], "0913100001"), randomUUID());
  assert.equal(again.status, 201, JSON.stringify(again.body));
  // Bringing the cancelled one back would go past the limit.
  const back = await as("SELAM_OWNER", "PATCH", `${checkoutFixture.quickPath}/registrations/${ticket.id}/status`, { status: "CONFIRMED" });
  assert.deepEqual([back.status, back.body.error.code], [409, "purchase_limit_reached"]);

  const list = await as("SELAM_OWNER", "GET", `${checkoutFixture.quickPath}/registrations?q=0913100001`);
  assert.ok(list.body.data.length >= 4, "the buyer's mobile finds unnamed tickets");
  assert.ok(list.body.data.every((row: { person: unknown; order: { buyer_mobile: string } }) => row.person === null && row.order.buyer_mobile === "+251913100001"));
  const csv = await download(tokenOf("SELAM_OWNER"), `${checkoutFixture.quickPath}/registrations/export`);
  assert.equal(csv.status, 200);
  assert.match(csv.bytes.toString("utf8"), /Unnamed ticket/);

  // A signed-in guest's order appears in My Tickets, with every code.
  const bought = await guestPost(`${checkoutFixture.quickPublic}/orders`, orderForm([{ ticket_type_code: "GA", quantity: 2 }]), { key: randomUUID(), token: guestAccessToken("SARA") });
  assert.equal(bought.status, 201, JSON.stringify(bought.body));
  const mine = await guestGet("/v1/customer/registrations", guestAccessToken("SARA"));
  const boughtCodes = bought.body.data.tickets.map((row: { code: string }) => row.code);
  assert.ok(boughtCodes.every((code: string) => mine.body.data.some((row: { code: string }) => row.code === code)), JSON.stringify(mine.body.data));
  const order = await TicketOrder.findOne({ where: { reference: bought.body.data.reference }, raw: true });
  assert.deepEqual([order?.buyer_mobile, order?.buyer_user_id], [GUESTS.SARA.mobile, GUESTS.SARA.id], "the account's verified mobile, not the form's");
});

// --- Phase 7 step 3b: paid checkout through Cheche Pay v2 (the client stubbed, as Central Auth is above) ----------

/**
 * Cheche Pay as the tests see it: initialize returns a checkout URL per tx_ref; merchant-verify answers from `ledger`
 * (tx_ref → status and amount), so a test decides what Cheche Pay "saw" before the webhook arrives.
 */
const ledger = new Map<string, { status: string; amount: string; succeededAt?: Date }>();

function stubChechePay() {
  ledger.clear();
  const initialize = mock.method(chechePayClient, "initialize", async (input: { txRef: string; secretKey: string; amount: string }) => ({
    checkoutUrl: `https://checkout.cheche.example/c/${input.txRef}`,
    txRef: input.txRef,
    transactionId: `cp-${input.txRef.slice(-6)}`,
    expiresAt: new Date(Date.now() + 30 * 60_000),
    raw: { stubbed: true },
  }));
  const verify = mock.method(chechePayClient, "verify", async (_key: string, txRef: string) => {
    const seen = ledger.get(txRef);
    return seen ? { status: seen.status, amount: seen.amount, currency: "ETB", isFinal: true, transactionId: "cp-1", succeededAt: seen.succeededAt ?? null, raw: {} } : null;
  });
  return { initialize, verify };
}

/** Cheche Pay's webhook for Selam, optionally signed. */
async function chechePayWebhook(txRef: string, signature?: string): Promise<TestResponse> {
  return withServer(app, async (baseUrl) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (signature !== undefined) headers["X-Cheche-Signature"] = signature;
    const response = await fetch(`${baseUrl}/v1/payments/cheche/webhook/${fixture.selamId}`, { method: "POST", headers, body: webhookPayload(txRef) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  });
}

function webhookPayload(txRef: string): string {
  return JSON.stringify({ event: "payment.succeeded", data: { tx_ref: txRef } });
}

/** The current attempt's tx_ref of an order, by its reference. */
async function txRefOf(reference: string): Promise<string> {
  const order = await TicketOrder.findOne({ where: { reference }, raw: true });
  assert.ok(order);
  const payment = await OrderPayment.findOne({ where: { order_id: order.id }, raw: true });
  assert.ok(payment?.tx_ref);
  return payment.tx_ref;
}

/** The buyer's order page (GET) or payment check (POST …/check), with the order token from checkout. */
async function orderPage(reference: string, token: string, check = false): Promise<TestResponse> {
  return withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/public/orders/${reference}${check ? "/check" : ""}`, { method: check ? "POST" : "GET", headers: { "X-Order-Token": token } });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  });
}

const paidFixture = { jazzPublic: "", jazzPath: "" };

test("row 93: 2 General Admission at 500 ETB and 1 VIP at 1,000 ETB come to 2,000 ETB with Selam's own Cheche Pay key; a verified webhook gives 3 distinct codes; the same webhook again changes nothing", { skip }, async () => {
  resetPublicLimit();
  const { initialize } = stubChechePay();
  try {
    const event = await publishedCheckoutEvent({ name: "Jazz Night", registration_mode: "QUICK" }, [{ code: "VIP", name: "VIP", price: "1000" }]);
    assert.equal((await as("SELAM_OWNER", "PATCH", `${event.path}/ticket-types/${event.types.GA}`, { price: "500" })).status, 200);
    Object.assign(paidFixture, { jazzPublic: event.publicPath, jazzPath: event.path });
    const orders = `${event.publicPath}/orders`;
    const items = [
      { ticket_type_code: "GA", quantity: 2 },
      { ticket_type_code: "VIP", quantity: 1 },
    ];

    const noKeys = await postWithKey(orders, orderForm(items, "0913200001"), randomUUID());
    assert.deepEqual([noKeys.status, noKeys.body.error.code, noKeys.body.error.details.reason], [409, "paid_sales_unavailable", "NO_CHECHE_PAY_KEYS"]);
    const keysPath = `/v1/organizations/${fixture.selamId}/cheche-pay`;
    assert.equal((await as("SELAM_OWNER", "PUT", keysPath, { secret_key: "sk_test_ownersown1" })).status, 403, "an Owner can't redirect the money");
    assert.equal((await as("SUPER", "PUT", keysPath, { secret_key: "pk_test_publishable" })).body.error.details.issues[0].code, "publishable_key");
    const saved = await as("SUPER", "PUT", keysPath, { secret_key: "sk_test_selamkey1234" });
    assert.deepEqual([saved.status, saved.body.data.secret_key_masked, saved.body.data.paid_sales_available], [200, "sk_test_••••1234", true]);
    assert.ok(!JSON.stringify(saved.body).includes("sk_test_selamkey1234"), "the key never comes back");
    const stored = await OrganizationChechePayCredential.findOne({ where: { organization_id: fixture.selamId }, raw: true });
    assert.ok(stored && !stored.secret_key_encrypted.includes("selamkey"), "stored encrypted");

    const created = await postWithKey(orders, orderForm(items, "0913200001"), randomUUID());
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const order = created.body.data;
    assert.deepEqual([order.status, order.total_amount, order.currency], ["PENDING_PAYMENT", "2000.00", "ETB"]);
    assert.ok(order.tickets.every((ticket: { code: string | null; status: string }) => ticket.code === null && ticket.status === "HELD"), "no codes before payment");
    const txRef = await txRefOf(order.reference);
    assert.equal(order.payment.checkout_url, `https://checkout.cheche.example/c/${txRef}`);
    const sent = initialize.mock.calls.at(-1)?.arguments[0] as unknown as { secretKey: string; amount: string; txRef: string };
    assert.deepEqual([sent.secretKey, sent.amount, sent.txRef], ["sk_test_selamkey1234", "2000.00", txRef], "Selam's own key, the exact total");
    assert.equal(chechePayClient.parseTxRef(txRef), (await OrderPayment.findOne({ where: { tx_ref: txRef }, raw: true }))?.id);

    assert.equal((await orderPage(order.reference, "x".repeat(43))).status, 404, "a wrong token looks like no order");
    const pending = await chechePayWebhook(txRef);
    assert.deepEqual([pending.status, pending.body.data.processed, pending.body.data.provider_status], [200, false, null], "Cheche Pay hasn't seen a payment: nothing changes");

    ledger.set(txRef, { status: "SUCCEEDED", amount: "2000.00" });
    const paid = await chechePayWebhook(txRef);
    assert.deepEqual([paid.status, paid.body.data.processed, paid.body.data.order_status], [200, true, "CONFIRMED"]);
    const again = await chechePayWebhook(txRef);
    assert.deepEqual([again.status, again.body.data.duplicate], [200, true]);

    const page = await orderPage(order.reference, order.order_token);
    assert.equal(page.body.data.status, "CONFIRMED");
    const codes = page.body.data.tickets.map((ticket: { code: string }) => ticket.code);
    assert.equal(new Set(codes).size, 3);
    const row = await TicketOrder.findOne({ where: { reference: order.reference }, raw: true });
    assert.equal(await MessageOutbox.count({ where: { order_id: row?.id } }), 1, "one confirmation, however many webhooks");
    assert.equal((await as("SELAM_OWNER", "GET", `${event.path}/registrations`)).body.data.length, 3, "the guest list shows the paid tickets");
  } finally {
    mock.restoreAll();
  }
});

test("row 94: SUCCEEDED for another amount issues nothing; a pending payment changes nothing; an unpaid expiry frees the places and the allowance; a late payment with no room left becomes REFUND_REQUIRED", { skip }, async () => {
  resetPublicLimit();
  stubChechePay();
  try {
    const orders = `${paidFixture.jazzPublic}/orders`;
    const wrong = await postWithKey(orders, orderForm([{ ticket_type_code: "GA", quantity: 1 }], "0913200002"), randomUUID());
    assert.equal(wrong.status, 201, JSON.stringify(wrong.body));
    const wrongRef = await txRefOf(wrong.body.data.reference);
    ledger.set(wrongRef, { status: "PENDING", amount: "500.00" });
    assert.equal((await chechePayWebhook(wrongRef)).body.data.provider_status, "PENDING");
    ledger.set(wrongRef, { status: "SUCCEEDED", amount: "1.00" });
    const review = await chechePayWebhook(wrongRef);
    assert.deepEqual([review.status, review.body.data.review_reason], [200, "AMOUNT_MISMATCH"]);
    const wrongPayment = await OrderPayment.findOne({ where: { tx_ref: wrongRef }, raw: true });
    assert.equal(wrongPayment?.status, "MISMATCH");
    const wrongOrder = await TicketOrder.findOne({ where: { reference: wrong.body.data.reference }, raw: true });
    assert.equal(wrongOrder?.status, "PENDING_PAYMENT");
    assert.equal(await Registration.count({ where: { order_id: wrongOrder?.id, status: "CONFIRMED" } }), 0);

    // The last place of a one-seat event: A holds it, doesn't pay in time; B buys it; A's late payment can't take it.
    const seat = await publishedCheckoutEvent({ name: "Private Tasting", registration_mode: "QUICK", capacity: 1, purchase_limit_per_mobile: 1 });
    assert.equal((await as("SELAM_OWNER", "PATCH", `${seat.path}/ticket-types/${seat.types.GA}`, { price: "500" })).status, 200);
    const buy = (mobile: string) => postWithKey(`${seat.publicPath}/orders`, orderForm([{ ticket_type_code: "GA", quantity: 1 }], mobile), randomUUID());
    const a = await buy("0913200003");
    assert.equal(a.status, 201, JSON.stringify(a.body));
    const aRef = await txRefOf(a.body.data.reference);
    await TicketOrder.update({ hold_expires_at: new Date(Date.now() - 60_000) }, { where: { reference: a.body.data.reference } });
    await paymentService.processDue(new Date());
    assert.equal((await TicketOrder.findOne({ where: { reference: a.body.data.reference }, raw: true }))?.status, "EXPIRED");
    const again = await buy("0913200003");
    assert.equal(again.status, 201, "the allowance came back with the place");
    await TicketOrder.update({ hold_expires_at: new Date(Date.now() - 60_000) }, { where: { reference: again.body.data.reference } });
    await paymentService.processDue(new Date());

    const b = await buy("0913200004");
    assert.equal(b.status, 201, JSON.stringify(b.body));
    const bRef = await txRefOf(b.body.data.reference);
    ledger.set(bRef, { status: "SUCCEEDED", amount: "500.00" });
    assert.equal((await chechePayWebhook(bRef)).body.data.order_status, "CONFIRMED");

    ledger.set(aRef, { status: "SUCCEEDED", amount: "500.00" });
    const late = await chechePayWebhook(aRef);
    assert.deepEqual([late.body.data.order_status, late.body.data.review_reason], ["REFUND_REQUIRED", "PAID_AFTER_RELEASE"]);
    assert.equal(await Registration.count({ where: { event_id: seat.id, status: "CONFIRMED" } }), 1, "never oversold");
  } finally {
    mock.restoreAll();
  }
});

test("row 95: with a webhook secret saved only signed webhooks count; the buyer's check confirms a payment; a held order blocks the last place; staff paid orders need a buyer mobile; the keys are platform-only", { skip }, async () => {
  resetPublicLimit();
  stubChechePay();
  try {
    const keysPath = `/v1/organizations/${fixture.selamId}/cheche-pay`;
    const secret = "whsec_selamtest123";
    assert.equal((await as("SUPER", "PUT", keysPath, { webhook_secret: secret })).body.data.has_webhook_secret, true);

    const seat = await publishedCheckoutEvent({ name: "Chef's Table", registration_mode: "QUICK", capacity: 1 });
    assert.equal((await as("SELAM_OWNER", "PATCH", `${seat.path}/ticket-types/${seat.types.GA}`, { price: "750" })).status, 200);
    const holding = await postWithKey(`${seat.publicPath}/orders`, orderForm([{ ticket_type_code: "GA", quantity: 1 }], "0913200005"), randomUUID());
    assert.equal(holding.status, 201, JSON.stringify(holding.body));
    const blocked = await postWithKey(`${seat.publicPath}/orders`, orderForm([{ ticket_type_code: "GA", quantity: 1 }], "0913200006"), randomUUID());
    assert.deepEqual([blocked.status, blocked.body.error.code], [409, "capacity_reached"]);

    const txRef = await txRefOf(holding.body.data.reference);
    ledger.set(txRef, { status: "SUCCEEDED", amount: "750.00" });
    assert.equal((await chechePayWebhook(txRef)).status, 401, "unsigned while a secret is saved");
    assert.equal((await chechePayWebhook(txRef, "sha256=deadbeef")).status, 401);
    assert.equal((await TicketOrder.findOne({ where: { reference: holding.body.data.reference }, raw: true }))?.status, "PENDING_PAYMENT", "nothing changed");

    // The webhook never arrives correctly; the buyer comes back and the order page checks.
    const checked = await orderPage(holding.body.data.reference, holding.body.data.order_token, true);
    assert.deepEqual([checked.status, checked.body.data.status], [200, "CONFIRMED"]);
    const order = await TicketOrder.findOne({ where: { reference: holding.body.data.reference }, raw: true });
    assert.equal((await MessageOutbox.findOne({ where: { order_id: order?.id }, raw: true }))?.status, "PENDING", "the SMS hasn't gone yet");
    assert.match(String(checked.body.data.tickets[0].code), /^[A-HJKMNP-Z2-9]{8}$/, "the code is on the order page anyway");
    const signature = createHmac("sha256", secret).update(webhookPayload(txRef)).digest("hex");
    assert.equal((await chechePayWebhook(txRef, signature)).body.data.duplicate, true, "a correctly signed webhook afterwards changes nothing");

    const gaId = (await as("SELAM_OWNER", "GET", `${paidFixture.jazzPath}/ticket-types`)).body.data[0].id;
    const noMobile = await as("SELAM_OWNER", "POST", `${paidFixture.jazzPath}/orders`, { items: [{ ticket_type_id: gaId, quantity: 1 }] });
    assert.deepEqual([noMobile.status, noMobile.body.error.details.issues[0].path], [400, "body.buyer_mobile"]);
    const staffPaid = await as("SELAM_OWNER", "POST", `${paidFixture.jazzPath}/orders`, { buyer_mobile: "0913200007", items: [{ ticket_type_id: gaId, quantity: 1 }] });
    assert.deepEqual([staffPaid.status, staffPaid.body.data.status, staffPaid.body.data.payment.key_mode], [201, "PENDING_PAYMENT", "test"]);
    assert.match(staffPaid.body.data.payment.checkout_url, /checkout\.cheche\.example/);
    assert.equal(typeof staffPaid.body.data.order_token, "string", "staff share the link and token with the buyer");

    const abay = await Organization.findOne({ where: { name: "Abay Pilot" }, raw: true });
    assert.ok(abay);
    assert.equal((await as("SELAM_OWNER", "GET", `/v1/organizations/${abay.id}/cheche-pay`)).status, 403);
    assert.equal((await as("SELAM_OWNER", "GET", keysPath)).status, 403, "not even their own: platform scope");
    assert.equal((await as("SUPER", "GET", keysPath)).body.data.secret_key_masked, "sk_test_••••1234");
  } finally {
    mock.restoreAll();
  }
});

// --- Phase 8 step 1: on a capped event every ticket counts against a mobile ---------------------------------------

test("row 96: with a limit of 4 per mobile, 3 public tickets and 1 staff ticket for the same number (written two ways) fill it; a 5th is refused in both channels; a capped event refuses tickets without a mobile; an uncapped one doesn't", { skip }, async () => {
  resetPublicLimit();
  const capped = await publishedCheckoutEvent({ name: "Pilot Concert", registration_mode: "QUICK", purchase_limit_per_mobile: 4 });
  const staffOrders = `${capped.path}/orders`;
  const publicOrders = `${capped.publicPath}/orders`;

  const three = await postWithKey(publicOrders, orderForm([{ ticket_type_code: "GA", quantity: 3 }], "0913300001"), randomUUID());
  assert.equal(three.status, 201, JSON.stringify(three.body));
  const one = await as("SELAM_OWNER", "POST", staffOrders, { buyer_mobile: "+251913300001", items: [{ ticket_type_id: capped.types.GA, quantity: 1 }] });
  assert.equal(one.status, 201, JSON.stringify(one.body));

  const fifthPublic = await postWithKey(publicOrders, orderForm([{ ticket_type_code: "GA", quantity: 1 }], "0913 300 001"), randomUUID());
  assert.deepEqual([fifthPublic.status, fifthPublic.body.error.code, fifthPublic.body.error.details], [409, "purchase_limit_reached", { limit: 4, held: 4, requested: 1 }]);
  const fifthStaff = await as("SELAM_OWNER", "POST", staffOrders, { buyer_mobile: "0913300001", items: [{ ticket_type_id: capped.types.GA, quantity: 1 }] });
  assert.equal(fifthStaff.body.error?.code, "purchase_limit_reached");

  const noMobile = await as("SELAM_OWNER", "POST", staffOrders, { items: [{ ticket_type_id: capped.types.GA, quantity: 1 }] });
  assert.deepEqual([noMobile.status, noMobile.body.error.details.issues[0].path, noMobile.body.error.details.issues[0].code], [400, "body.buyer_mobile", "buyer_mobile_required"]);
  const phoneless = await as("SELAM_OWNER", "POST", `${capped.path}/registrations`, { person: { first_name: "Abel" } });
  assert.deepEqual([phoneless.status, phoneless.body.error.details.issues[0].path, phoneless.body.error.details.issues[0].code], [400, "body.person.phone", "buyer_mobile_required"]);
  const cappedRow = await AppEvent.findByPk(capped.id, { raw: true });
  assert.equal(await Registration.count({ where: { event_id: cappedRow?.id, status: "CONFIRMED" } }), 4, "exactly the 4 allowed");

  const uncapped = await publishedCheckoutEvent({ name: "Open Rehearsal", registration_mode: "QUICK" });
  const free = await as("SELAM_OWNER", "POST", `${uncapped.path}/orders`, { items: [{ ticket_type_id: uncapped.types.GA, quantity: 1 }] });
  assert.deepEqual([free.status, free.body.data.buyer_mobile], [201, null], "no limit: staff may still leave the mobile out");
  assert.equal(free.body.data.confirmation, null, "no buyer mobile, no SMS");
});

// --- Phase 8 step 2: QR payload and admission at the door ----------------------------------------------------------

/** A gate (or staff typing a code) admitting a ticket, with the gate request's retry key. */
async function gateScan(person: Person, eventPath: string, code: string, key: string): Promise<TestResponse> {
  const token = tokens.get(person);
  assert.ok(token);
  return withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}${eventPath}/check-ins`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "Idempotency-Key": key },
      body: JSON.stringify({ code }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  });
}

const doorFixture = { eventPath: "", publicPath: "", codes: [] as string[] };

/** Phase 9: the gate admits only from the door time; the test events start in 2027, so their doors opened an hour ago. */
const doorsOpenedAnHourAgo = () => new Date(Date.now() - 3_600_000).toISOString();

test("row 97: each ticket's QR payload is exactly its code on the order page, My Tickets and the staff order; two gates racing admit it once; the winning request retried gets its original result; the other ticket of the order is admitted on its own", { skip }, async () => {
  resetPublicLimit();
  const event = await publishedCheckoutEvent({ name: "Pilot Gala", registration_mode: "QUICK", doors_open_at: doorsOpenedAnHourAgo() });
  Object.assign(doorFixture, { eventPath: event.path, publicPath: event.publicPath });
  const bought = await guestPost(`${event.publicPath}/orders`, orderForm([{ ticket_type_code: "GA", quantity: 2 }]), { key: randomUUID(), token: guestAccessToken("SARA") });
  assert.equal(bought.status, 201, JSON.stringify(bought.body));
  const codes = bought.body.data.tickets.map((ticket: { code: string }) => ticket.code) as string[];
  doorFixture.codes = codes;
  assert.ok(codes.every((code) => /^[A-HJKMNP-Z2-9]{8}$/.test(code)), "the payload: the 8-character code only");
  assert.equal(new Set(codes).size, 2);

  const recovered = await withServer(app, async (baseUrl) => (await fetch(`${baseUrl}/v1/public/orders/${bought.body.data.reference}`, { headers: { "X-Order-Token": bought.body.data.order_token } })).json());
  assert.deepEqual((recovered as { data: { tickets: Array<{ code: string }> } }).data.tickets.map((ticket) => ticket.code).sort(), [...codes].sort(), "guest order recovery");
  const mine = await guestGet("/v1/customer/registrations", guestAccessToken("SARA"));
  assert.ok(codes.every((code) => mine.body.data.some((row: { code: string }) => row.code === code)), "My Tickets");
  const order = await TicketOrder.findOne({ where: { reference: bought.body.data.reference }, raw: true });
  const staffOrder = await as("SELAM_OWNER", "GET", `${event.path}/orders/${order?.id}`);
  assert.deepEqual(staffOrder.body.data.tickets.map((ticket: { code: string }) => ticket.code).sort(), [...codes].sort(), "the staff order");

  assert.equal((await as("SELAM_OWNER", "GET", `${event.path}/registrations/summary`)).body.data.checked_in, 0);
  const gateKeys = [randomUUID(), randomUUID()];
  const race = await Promise.all(gateKeys.map((key) => gateScan("SELAM_OWNER", event.path, codes[0] as string, key)));
  assert.deepEqual(race.map((response) => response.status), [200, 200]);
  assert.deepEqual(race.map((response) => response.body.data.result).sort(), ["ADMITTED", "ALREADY_CHECKED_IN"]);
  assert.equal(race[0]?.body.data.checked_in_at, race[1]?.body.data.checked_in_at, "the second gate sees the original time");
  assert.equal(race[0]?.body.data.ticket.ticket_type.code, "GA");
  assert.equal(await TicketAdmission.count({ where: { event_id: event.id } }), 1, "one admission");
  assert.equal((await as("SELAM_OWNER", "GET", `${event.path}/registrations/summary`)).body.data.checked_in, 1, "the count rose by one");

  const winnerIndex = race.findIndex((response) => response.body.data.result === "ADMITTED");
  const retried = await gateScan("SELAM_OWNER", event.path, codes[0] as string, gateKeys[winnerIndex] as string);
  assert.deepEqual([retried.body.data.result, retried.body.data.checked_in_at], ["ADMITTED", race[winnerIndex]?.body.data.checked_in_at], "the winning request, retried after a lost response: its original result");
  const loserRetried = await gateScan("SELAM_OWNER", event.path, codes[0] as string, gateKeys[1 - winnerIndex] as string);
  assert.equal(loserRetried.body.data.result, "ALREADY_CHECKED_IN", "the other gate's request, retried: still already checked in");
  const retryKey = randomUUID();
  const second = await gateScan("SELAM_OWNER", event.path, codes[1] as string, retryKey);
  assert.equal(second.body.data.result, "ADMITTED", "the other ticket of the order on its own");
  const secondAgain = await gateScan("SELAM_OWNER", event.path, codes[1] as string, retryKey);
  assert.deepEqual([secondAgain.body.data.result, secondAgain.body.data.checked_in_at], ["ADMITTED", second.body.data.checked_in_at], "the same request again: its original result");
  assert.equal((await as("SELAM_OWNER", "GET", `${event.path}/registrations/summary`)).body.data.checked_in, 2);
  const admitted = await as("SELAM_OWNER", "GET", `${event.path}/registrations?checked_in=true`);
  assert.equal(admitted.body.data.length, 2);
  assert.ok(admitted.body.data.every((row: { checked_in_at: string | null; checked_in_by: string; status: string }) => row.checked_in_at !== null && row.checked_in_by === PEOPLE.SELAM_OWNER && row.status === "CONFIRMED"), "the registration and its place are kept");
});

test("row 98: at the door a cancelled ticket is refused, a held ticket has no code to present, another event's code is not found; another organization's Owner and a Viewer can't admit", { skip }, async () => {
  resetPublicLimit();
  const event = await publishedCheckoutEvent({ name: "Pilot Matinee", registration_mode: "QUICK", doors_open_at: doorsOpenedAnHourAgo() });
  const free = await as("SELAM_OWNER", "POST", `${event.path}/orders`, { buyer_mobile: "0913400001", items: [{ ticket_type_id: event.types.GA, quantity: 1 }] });
  const ticket = free.body.data.tickets[0] as { id: string; code: string };
  assert.equal((await as("SELAM_OWNER", "PATCH", `${event.path}/registrations/${ticket.id}/status`, { status: "CANCELLED" })).status, 200);
  const cancelled = await gateScan("SELAM_OWNER", event.path, ticket.code, randomUUID());
  assert.deepEqual([cancelled.status, cancelled.body.error.code, cancelled.body.error.details.status], [409, "ticket_not_admissible", "CANCELLED"]);

  stubChechePay();
  try {
    assert.equal((await as("SELAM_OWNER", "PATCH", `${event.path}/ticket-types/${event.types.GA}`, { price: "300" })).status, 200);
    const held = await postWithKey(`${event.publicPath}/orders`, orderForm([{ ticket_type_code: "GA", quantity: 1 }], "0913400002"), randomUUID());
    assert.equal(held.status, 201, JSON.stringify(held.body));
    assert.equal(held.body.data.tickets[0].code, null, "a held (or released) ticket has no code, so there is nothing to scan");
  } finally {
    mock.restoreAll();
  }

  const elsewhere = await gateScan("SELAM_OWNER", event.path, doorFixture.codes[0] as string, randomUUID());
  assert.deepEqual([elsewhere.status, elsewhere.body.error.code], [404, "not_found"], "a code of another event");
  assert.equal((await gateScan("HORN_OWNER", doorFixture.eventPath, doorFixture.codes[1] as string, randomUUID())).status, 403, "another organization");
  assert.equal((await gateScan("SELAM_VIEWER", doorFixture.eventPath, doorFixture.codes[1] as string, randomUUID())).status, 403, "view-only");
  assert.equal(await TicketAdmission.count({ where: { event_id: event.id } }), 0, "refusals write nothing");
});

// --- Phase 8 step 3: payment cases ---------------------------------------------------------------------------------

/** Selam's webhook, signed with the secret row 95 saved. */
async function signedWebhook(txRef: string): Promise<TestResponse> {
  return chechePayWebhook(txRef, createHmac("sha256", "whsec_selamtest123").update(webhookPayload(txRef)).digest("hex"));
}

/** The buyer's "Pay now" (a new attempt when the last checkout link has expired). */
async function payNow(reference: string, token: string): Promise<TestResponse> {
  return withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/public/orders/${reference}/payment`, { method: "POST", headers: { "X-Order-Token": token } });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  });
}

test("row 99: a double charge, a late payment whose places were sold and a mismatched amount each open one case with its payment reference; staff record the outcome once; tickets stay as they should; other tenants and view-only staff can't see or resolve", { skip }, async () => {
  resetPublicLimit();
  stubChechePay();
  try {
    const event = await publishedCheckoutEvent({ name: "Pilot Recital", registration_mode: "QUICK" });
    assert.equal((await as("SELAM_OWNER", "PATCH", `${event.path}/ticket-types/${event.types.GA}`, { price: "400" })).status, 200);
    const buy = (mobile: string, quantity = 1, path = event.publicPath) => postWithKey(`${path}/orders`, orderForm([{ ticket_type_code: "GA", quantity }], mobile), randomUUID());

    // A double charge: the first checkout link expired, the buyer paid on both attempts.
    const twice = await buy("0913500001", 2);
    assert.equal(twice.status, 201, JSON.stringify(twice.body));
    const firstRef = await txRefOf(twice.body.data.reference);
    await OrderPayment.update({ checkout_expires_at: new Date(Date.now() - 60_000) }, { where: { tx_ref: firstRef } });
    assert.equal((await payNow(twice.body.data.reference, twice.body.data.order_token)).status, 200);
    const secondRef = await txRefOf(twice.body.data.reference);
    assert.notEqual(secondRef, firstRef, "a new attempt");
    ledger.set(firstRef, { status: "SUCCEEDED", amount: "800.00" });
    assert.equal((await signedWebhook(firstRef)).body.data.order_status, "CONFIRMED");
    ledger.set(secondRef, { status: "SUCCEEDED", amount: "800.00" });
    assert.equal((await signedWebhook(secondRef)).body.data.review_reason, "PAID_TWICE");
    await signedWebhook(secondRef);

    // A late payment: the only place went to someone else while the hold had lapsed.
    const seat = await publishedCheckoutEvent({ name: "Pilot Duet", registration_mode: "QUICK", capacity: 1 });
    assert.equal((await as("SELAM_OWNER", "PATCH", `${seat.path}/ticket-types/${seat.types.GA}`, { price: "400" })).status, 200);
    const late = await buy("0913500002", 1, seat.publicPath);
    const lateRef = await txRefOf(late.body.data.reference);
    await TicketOrder.update({ hold_expires_at: new Date(Date.now() - 60_000) }, { where: { reference: late.body.data.reference } });
    await paymentService.processDue(new Date());
    const winner = await buy("0913500003", 1, seat.publicPath);
    const winnerRef = await txRefOf(winner.body.data.reference);
    ledger.set(winnerRef, { status: "SUCCEEDED", amount: "400.00" });
    await signedWebhook(winnerRef);
    ledger.set(lateRef, { status: "SUCCEEDED", amount: "400.00" });
    assert.equal((await signedWebhook(lateRef)).body.data.order_status, "REFUND_REQUIRED");
    await signedWebhook(lateRef);

    // A mismatched amount.
    const odd = await buy("0913500004");
    const oddRef = await txRefOf(odd.body.data.reference);
    ledger.set(oddRef, { status: "SUCCEEDED", amount: "4.00" });
    await signedWebhook(oddRef);
    await signedWebhook(oddRef);

    const casesPath = `/v1/organizations/${fixture.selamId}/payment-cases`;
    const open = await as("SELAM_OWNER", "GET", `${casesPath}?status=OPEN`);
    assert.equal(open.status, 200, JSON.stringify(open.body));
    const mine = (open.body.data as Array<{ id: string; kind: string; tx_ref: string; amount: string; event_id: string }>).filter((row) => [secondRef, lateRef, oddRef, firstRef, winnerRef].includes(row.tx_ref));
    assert.deepEqual(
      mine.map((row) => [row.kind, row.tx_ref, row.amount]).sort(),
      [
        ["AMOUNT_MISMATCH", oddRef, "4.00"],
        ["PAID_TWICE", secondRef, "800.00"],
        ["REFUND_REQUIRED", lateRef, "400.00"],
      ].sort(),
      "one case each, however many webhooks; the valid charges have none",
    );
    const caseOf = (kind: string) => mine.find((row) => row.kind === kind)?.id as string;

    const twiceCase = await as("SELAM_OWNER", "GET", `${casesPath}/${caseOf("PAID_TWICE")}`);
    assert.deepEqual([twiceCase.body.data.payment.paid_tx_ref, twiceCase.body.data.order.status, twiceCase.body.data.order.tickets.length], [firstRef, "CONFIRMED", 2]);
    const refund = { resolution: "REFUNDED", refunded_amount: "800", refunded_currency: "ETB", merchant_reference: "CP-REFUND-99" };
    const resolved = await as("SELAM_OWNER", "POST", `${casesPath}/${caseOf("PAID_TWICE")}/resolve`, refund);
    assert.deepEqual([resolved.status, resolved.body.data.status, resolved.body.data.resolution.refunded_amount, resolved.body.data.resolution.resolved_by], [200, "RESOLVED", "800.00", PEOPLE.SELAM_OWNER]);
    const again = await as("SELAM_OWNER", "POST", `${casesPath}/${caseOf("PAID_TWICE")}/resolve`, refund);
    assert.equal(again.body.data.resolution.resolved_at, resolved.body.data.resolution.resolved_at, "the same action again: one effect");
    assert.equal((await as("SELAM_OWNER", "POST", `${casesPath}/${caseOf("PAID_TWICE")}/resolve`, { resolution: "CLOSED_WITHOUT_REFUND", note: "no" })).status, 409);
    const twiceOrder = await TicketOrder.findOne({ where: { reference: twice.body.data.reference }, raw: true });
    assert.equal(await Registration.count({ where: { order_id: twiceOrder?.id, status: "CONFIRMED" } }), 2, "closing a double charge keeps the tickets of the valid one");

    const lateResolved = await as("SELAM_OWNER", "POST", `${casesPath}/${caseOf("REFUND_REQUIRED")}/resolve`, { ...refund, refunded_amount: "400", merchant_reference: "CP-REFUND-100" });
    assert.equal(lateResolved.body.data.tx_ref, lateRef);
    assert.equal(lateResolved.body.data.order.status, "REFUND_REQUIRED");
    assert.equal(await Registration.count({ where: { event_id: seat.id, status: "CONFIRMED" } }), 1, "still never oversold");

    const oddClosed = await as("SELAM_OWNER", "POST", `${casesPath}/${caseOf("AMOUNT_MISMATCH")}/resolve`, { resolution: "CLOSED_WITHOUT_REFUND", note: "Organizer's test transfer" });
    assert.deepEqual([oddClosed.body.data.resolution.outcome, oddClosed.body.data.tx_ref, oddClosed.body.data.payment.status], ["CLOSED_WITHOUT_REFUND", oddRef, "MISMATCH"]);
    const oddOrder = await TicketOrder.findOne({ where: { reference: odd.body.data.reference }, raw: true });
    assert.equal(await Registration.count({ where: { order_id: oddOrder?.id, status: "CONFIRMED" } }), 0, "a mismatch never issues");

    assert.equal((await as("HORN_OWNER", "GET", casesPath)).status, 403, "another organization");
    assert.equal((await as("SELAM_VIEWER", "GET", casesPath)).status, 403, "Viewers have no Payments");
    assert.equal((await as("SELAM_VIEWER", "POST", `${casesPath}/${caseOf("AMOUNT_MISMATCH")}/resolve`, refund)).status, 403);
  } finally {
    mock.restoreAll();
  }
});

// --- Phase 8 step 4: partial returns ------------------------------------------------------------------------------

/** An order's tickets as staff see them (ids, codes, ticket types), by its reference. */
async function staffTicketsOf(eventPath: string, reference: string): Promise<Array<{ id: string; code: string; status: string; ticket_type: { code: string } }>> {
  const order = await TicketOrder.findOne({ where: { reference }, raw: true });
  assert.ok(order);
  return (await as("SELAM_OWNER", "GET", `${eventPath}/orders/${order.id}`)).body.data.tickets;
}

test("row 100: returning the unused VIP of a paid order after its price changed leaves exactly 1,000 ETB due, frees one place and the buyer's allowance, keeps both General Admission codes valid; a retry gives one case; a free ticket returns with no case; a return racing a check-in has one winner; the status route opens a case and refuses a used ticket", { skip }, async () => {
  resetPublicLimit();
  stubChechePay();
  try {
    const event = await publishedCheckoutEvent({ name: "Pilot Gala Dinner", registration_mode: "QUICK", purchase_limit_per_mobile: 3, doors_open_at: doorsOpenedAnHourAgo() }, [
      { code: "VIP", name: "VIP", price: "1000" },
      { code: "KIDS", name: "Kids", price: "0" },
    ]);
    assert.equal((await as("SELAM_OWNER", "PATCH", `${event.path}/ticket-types/${event.types.GA}`, { price: "500" })).status, 200);
    const orders = `${event.publicPath}/orders`;
    const pay = async (reference: string, amount: string) => {
      const txRef = await txRefOf(reference);
      ledger.set(txRef, { status: "SUCCEEDED", amount });
      assert.equal((await signedWebhook(txRef)).body.data.order_status, "CONFIRMED");
    };

    const bought = await postWithKey(orders, orderForm([{ ticket_type_code: "GA", quantity: 2 }, { ticket_type_code: "VIP", quantity: 1 }], "0913600001"), randomUUID());
    assert.equal(bought.status, 201, JSON.stringify(bought.body));
    await pay(bought.body.data.reference, "2000.00");
    const tickets = await staffTicketsOf(event.path, bought.body.data.reference);
    const vip = tickets.find((ticket) => ticket.ticket_type.code === "VIP");
    const gas = tickets.filter((ticket) => ticket.ticket_type.code === "GA");
    assert.ok(vip && gas.length === 2);
    const atLimit = await postWithKey(orders, orderForm([{ ticket_type_code: "KIDS", quantity: 1 }], "0913600001"), randomUUID());
    assert.equal(atLimit.body.error?.code, "purchase_limit_reached", "3 of 3 before the return");

    assert.equal((await as("SELAM_OWNER", "PATCH", `${event.path}/ticket-types/${event.types.VIP}`, { price: "1500" })).status, 200, "the catalog price changes");
    const before = (await as("SELAM_OWNER", "GET", `${event.path}/registrations/summary`)).body.data;

    const returned = await as("SELAM_OWNER", "POST", `${event.path}/registrations/${vip.id}/return`);
    assert.deepEqual(
      [returned.status, returned.body.data.outcome, returned.body.data.registration.status, returned.body.data.refund_case.kind, returned.body.data.refund_case.amount, returned.body.data.refund_case.currency],
      [200, "RETURNED", "CANCELLED", "TICKET_RETURN", "1000.00", "ETB"],
      "exactly the 1,000 ETB paid, not today's 1,500",
    );
    const after = (await as("SELAM_OWNER", "GET", `${event.path}/registrations/summary`)).body.data;
    const vipCount = (summary: { ticket_types: Array<{ code: string; confirmed: number }> }) => summary.ticket_types.find((type) => type.code === "VIP")?.confirmed;
    assert.deepEqual([after.confirmed, vipCount(after)], [before.confirmed - 1, (vipCount(before) as number) - 1], "one event place and one VIP place back");
    assert.equal((await postWithKey(orders, orderForm([{ ticket_type_code: "KIDS", quantity: 1 }], "+251913600001"), randomUUID())).status, 201, "one unit of the buyer's allowance back");

    const retried = await as("SELAM_OWNER", "POST", `${event.path}/registrations/${vip.id}/return`);
    assert.deepEqual([retried.body.data.outcome, retried.body.data.refund_case.id], ["ALREADY_RETURNED", returned.body.data.refund_case.id]);
    assert.equal(await PaymentCase.count({ where: { registration_id: vip.id } }), 1, "one refund case");
    const vipAtDoor = await gateScan("SELAM_OWNER", event.path, vip.code, randomUUID());
    assert.deepEqual([vipAtDoor.status, vipAtDoor.body.error.code], [409, "ticket_not_admissible"], "the returned ticket is invalid at the door");
    for (const ga of gas) assert.equal((await gateScan("SELAM_OWNER", event.path, ga.code, randomUUID())).body.data.result, "ADMITTED", "the other tickets stay usable");
    const usedCancel = await as("SELAM_OWNER", "PATCH", `${event.path}/registrations/${gas[0]?.id}/status`, { status: "CANCELLED" });
    assert.deepEqual([usedCancel.status, usedCancel.body.error.code], [409, "ticket_already_used"]);
    assert.deepEqual([(await as("SELAM_OWNER", "POST", `${event.path}/registrations/${gas[1]?.id}/return`)).body.error?.code], ["ticket_already_used"]);

    // A mixed order: the free ticket returns with no case; its paid ticket races a check-in.
    const mixed = await postWithKey(orders, orderForm([{ ticket_type_code: "KIDS", quantity: 1 }, { ticket_type_code: "GA", quantity: 1 }], "0913600002"), randomUUID());
    await pay(mixed.body.data.reference, "500.00");
    const mixedTickets = await staffTicketsOf(event.path, mixed.body.data.reference);
    const kids = mixedTickets.find((ticket) => ticket.ticket_type.code === "KIDS");
    const mixedGa = mixedTickets.find((ticket) => ticket.ticket_type.code === "GA");
    assert.ok(kids && mixedGa);
    const freeReturn = await as("SELAM_OWNER", "POST", `${event.path}/registrations/${kids.id}/return`);
    assert.deepEqual([freeReturn.body.data.outcome, freeReturn.body.data.refund_case], ["RETURNED", null], "a free ticket finishes at cancellation");
    const [scan, giveBack] = await Promise.all([gateScan("SELAM_OWNER", event.path, mixedGa.code, randomUUID()), as("SELAM_OWNER", "POST", `${event.path}/registrations/${mixedGa.id}/return`)]);
    const admittedWon = scan.status === 200 && giveBack.status === 409 && giveBack.body.error.code === "ticket_already_used";
    const returnWon = giveBack.status === 200 && scan.status === 409 && scan.body.error.code === "ticket_not_admissible";
    assert.ok(admittedWon !== returnWon, `exactly one wins: scan ${scan.status}, return ${giveBack.status}`);
    assert.equal(await PaymentCase.count({ where: { registration_id: mixedGa.id } }), returnWon ? 1 : 0);

    // The status route cancels a paid ticket as a return.
    const single = await postWithKey(orders, orderForm([{ ticket_type_code: "GA", quantity: 1 }], "0913600003"), randomUUID());
    await pay(single.body.data.reference, "500.00");
    const [singleTicket] = await staffTicketsOf(event.path, single.body.data.reference);
    assert.equal((await as("SELAM_OWNER", "PATCH", `${event.path}/registrations/${singleTicket?.id}/status`, { status: "CANCELLED" })).status, 200);
    const statusCase = await PaymentCase.findOne({ where: { registration_id: singleTicket?.id }, raw: true });
    assert.deepEqual([statusCase?.kind, statusCase?.amount], ["TICKET_RETURN", "500.00"]);

    // The refund is complete once staff record the merchant's refund reference.
    const casesPath = `/v1/organizations/${fixture.selamId}/payment-cases`;
    const refunded = await as("SELAM_OWNER", "POST", `${casesPath}/${returned.body.data.refund_case.id}/resolve`, { resolution: "REFUNDED", refunded_amount: "1000", refunded_currency: "ETB", merchant_reference: "CP-RET-100" });
    assert.deepEqual([refunded.body.data.status, refunded.body.data.ticket.status, refunded.body.data.order.status], ["RESOLVED", "CANCELLED", "CONFIRMED"], "the original charge and order stand");
    const original = await OrderPayment.findOne({ where: { tx_ref: await txRefOf(bought.body.data.reference) }, raw: true });
    assert.deepEqual([original?.status, original?.amount], ["PAID", "2000.00"], "the original charge and price history are kept");

    assert.equal((await as("HORN_OWNER", "POST", `${event.path}/registrations/${singleTicket?.id}/return`)).status, 403, "another organization");
    assert.equal((await as("SELAM_VIEWER", "POST", `${event.path}/registrations/${gas[0]?.id}/return`)).status, 403, "view-only");
  } finally {
    mock.restoreAll();
  }
});

// --- Phase 9: event changes after sales ---------------------------------------------------------------------------

test("row 101: cancelling an event after its first admission releases holds once, cancels unused tickets, keeps the used one, opens one refund case per paid order, texts every affected buyer once; a later payment only opens a refund case; a repeat changes nothing", { skip }, async () => {
  resetPublicLimit();
  stubChechePay();
  try {
    const event = await publishedCheckoutEvent({ name: "Pilot Festival", registration_mode: "QUICK", doors_open_at: doorsOpenedAnHourAgo() }, [{ code: "KIDS", name: "Kids", price: "0" }]);
    assert.equal((await as("SELAM_OWNER", "PATCH", `${event.path}/ticket-types/${event.types.GA}`, { price: "500" })).status, 200);
    const orders = `${event.publicPath}/orders`;
    const pay = async (reference: string, amount: string) => {
      const txRef = await txRefOf(reference);
      ledger.set(txRef, { status: "SUCCEEDED", amount });
      assert.equal((await signedWebhook(txRef)).body.data.order_status, "CONFIRMED");
    };
    const paid = await postWithKey(orders, orderForm([{ ticket_type_code: "GA", quantity: 2 }], "0913700001"), randomUUID());
    await pay(paid.body.data.reference, "1000.00");
    const mixed = await postWithKey(orders, orderForm([{ ticket_type_code: "KIDS", quantity: 1 }, { ticket_type_code: "GA", quantity: 1 }], "0913700002"), randomUUID());
    await pay(mixed.body.data.reference, "500.00");
    const free = await postWithKey(orders, orderForm([{ ticket_type_code: "KIDS", quantity: 1 }], "0913700003"), randomUUID());
    assert.equal(free.status, 201);
    const held = await postWithKey(orders, orderForm([{ ticket_type_code: "GA", quantity: 1 }], "0913700004"), randomUUID());
    assert.equal(held.body.data.status, "PENDING_PAYMENT");
    const paidTickets = await staffTicketsOf(event.path, paid.body.data.reference);
    assert.equal((await gateScan("SELAM_OWNER", event.path, paidTickets[0]?.code as string, randomUUID())).body.data.result, "ADMITTED");

    const undecided = await as("SELAM_OWNER", "POST", `${event.path}/cancel`, {});
    assert.deepEqual([undecided.status, undecided.body.error.details.issues[0].code], [400, "refund_decision_required"]);
    const cancelled = await as("SELAM_OWNER", "POST", `${event.path}/cancel`, { refund_admitted_tickets: false });
    assert.deepEqual([cancelled.status, cancelled.body.data.status, cancelled.body.data.refund_admitted_tickets], [200, "CANCELLED", false]);

    const statusOf = async (reference: string) => (await staffTicketsOf(event.path, reference)).map((ticket) => ticket.status).sort();
    assert.deepEqual(await statusOf(paid.body.data.reference), ["CANCELLED", "CONFIRMED"], "the used ticket keeps its admission");
    assert.deepEqual(await statusOf(mixed.body.data.reference), ["CANCELLED", "CANCELLED"]);
    assert.deepEqual(await statusOf(free.body.data.reference), ["CANCELLED"]);
    assert.equal((await TicketOrder.findOne({ where: { reference: held.body.data.reference }, raw: true }))?.status, "EXPIRED", "the hold is released");
    const orderIdOf = async (reference: string): Promise<string> => {
      const row = await TicketOrder.findOne({ where: { reference }, raw: true });
      assert.ok(row);
      return row.id;
    };
    const cases = await PaymentCase.findAll({ where: { event_id: event.id, kind: "EVENT_CANCELLATION" }, raw: true });
    assert.deepEqual(
      cases.map((row) => [row.order_id, row.amount]).sort(),
      [
        [await orderIdOf(paid.body.data.reference), "500.00"],
        [await orderIdOf(mixed.body.data.reference), "500.00"],
      ].sort(),
      "the unused paid tickets at their price; the free ticket adds nothing; the free order has none",
    );
    assert.equal(await MessageOutbox.count({ where: { kind: "EVENT_CANCELLED", order_id: [await orderIdOf(paid.body.data.reference), await orderIdOf(mixed.body.data.reference), await orderIdOf(free.body.data.reference), await orderIdOf(held.body.data.reference)] } }), 4);
    assert.equal((await as("SELAM_OWNER", "GET", `${event.path}/registrations/summary`)).body.data.confirmed, 1);
    assert.equal((await gateScan("SELAM_OWNER", event.path, paidTickets[1]?.code as string, randomUUID())).body.error.code, "invalid_event_state", "no more admissions");
    assert.equal((await publicGet(event.publicPath)).body.data.display_status, "CANCELLED", "the direct link says Cancelled");

    assert.equal((await as("SELAM_OWNER", "POST", `${event.path}/cancel`, { refund_admitted_tickets: true })).status, 200);
    assert.equal(await PaymentCase.count({ where: { event_id: event.id, kind: "EVENT_CANCELLATION" } }), 2, "a repeat creates no second obligation");
    assert.equal(await MessageOutbox.count({ where: { kind: "EVENT_CANCELLED", order_id: await orderIdOf(paid.body.data.reference) } }), 1);

    const lateRef = await txRefOf(held.body.data.reference);
    ledger.set(lateRef, { status: "SUCCEEDED", amount: "500.00" });
    const late = await signedWebhook(lateRef);
    assert.deepEqual([late.body.data.order_status, late.body.data.review_reason], ["REFUND_REQUIRED", "EVENT_CANCELLED"]);
    assert.equal(await PaymentCase.count({ where: { tx_ref: lateRef, kind: "REFUND_REQUIRED" } }), 1);
    assert.deepEqual(await statusOf(held.body.data.reference), ["RELEASED"], "no seat, no ticket");

    const draft = await as("SELAM_OWNER", "POST", `/v1/organizations/${fixture.selamId}/events`, { name: "Never Shown" });
    assert.equal((await as("SELAM_OWNER", "POST", `/v1/organizations/${fixture.selamId}/events/${draft.body.data.id}/cancel`, {})).body.data.status, "CANCELLED");
    assert.equal((await publicGet(`/v1/public/organizations/selam-events/events/${draft.body.data.slug}`)).status, 404, "a cancelled draft stays private");
  } finally {
    mock.restoreAll();
  }
});

test("row 102: sales closed at 18:00 with Hana's hold to 18:10: a payment at 18:04 heard of at 18:12 completes; a payment at 18:12 opens one full-order refund case even with seats free", { skip }, async () => {
  resetPublicLimit();
  stubChechePay();
  try {
    const event = await publishedCheckoutEvent({ name: "Pilot Sunset", registration_mode: "QUICK" });
    assert.equal((await as("SELAM_OWNER", "PATCH", `${event.path}/ticket-types/${event.types.GA}`, { price: "500" })).status, 200);
    const hana = await postWithKey(`${event.publicPath}/orders`, orderForm([{ ticket_type_code: "GA", quantity: 2 }], "0913800001"), randomUUID());
    const other = await postWithKey(`${event.publicPath}/orders`, orderForm([{ ticket_type_code: "GA", quantity: 1 }], "0913800002"), randomUUID());
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    // "Now" is 18:12: the cutoff was 12 minutes ago and both holds ended 2 minutes ago.
    assert.equal((await as("SELAM_OWNER", "PATCH", event.path, { registration_closes_at: minutesAgo(12).toISOString() })).status, 200);
    await TicketOrder.update({ hold_expires_at: minutesAgo(2) }, { where: { reference: [hana.body.data.reference, other.body.data.reference] } });

    const hanaRef = await txRefOf(hana.body.data.reference);
    ledger.set(hanaRef, { status: "SUCCEEDED", amount: "1000.00", succeededAt: minutesAgo(8) });
    assert.equal((await signedWebhook(hanaRef)).body.data.order_status, "CONFIRMED", "18:04: on time, at the original price");
    assert.ok((await OrderPayment.findOne({ where: { tx_ref: hanaRef }, raw: true }))?.succeeded_at, "the success time is kept");

    const otherRef = await txRefOf(other.body.data.reference);
    ledger.set(otherRef, { status: "SUCCEEDED", amount: "500.00", succeededAt: new Date() });
    const late = await signedWebhook(otherRef);
    assert.deepEqual([late.body.data.order_status, late.body.data.review_reason], ["REFUND_REQUIRED", "PAID_AFTER_DEADLINE"]);
    const lateCases = await PaymentCase.findAll({ where: { tx_ref: otherRef }, raw: true });
    assert.deepEqual(lateCases.map((row) => [row.kind, row.amount]), [["REFUND_REQUIRED", "500.00"]], "one full-order case, though seats were free");
  } finally {
    mock.restoreAll();
  }
});

test("row 103: the door opens at doors_open_at (or starts_at) and stays open whatever the sales cutoff or a stopped ticket type", { skip }, async () => {
  resetPublicLimit();
  const event = await publishedCheckoutEvent({ name: "Pilot Expo", registration_mode: "QUICK", doors_open_at: new Date(Date.now() + 3_600_000).toISOString() }, [{ code: "VIP", name: "VIP", price: "0" }]);
  const order = await as("SELAM_OWNER", "POST", `${event.path}/orders`, { buyer_mobile: "0913900001", items: [{ ticket_type_id: event.types.GA, quantity: 1 }, { ticket_type_id: event.types.VIP, quantity: 1 }] });
  const [first, second] = order.body.data.tickets as Array<{ code: string; ticket_type: { code: string } }>;
  const early = await gateScan("SELAM_OWNER", event.path, first?.code as string, randomUUID());
  assert.deepEqual([early.status, early.body.error.code], [409, "outside_admission_window"]);

  assert.equal((await as("SELAM_OWNER", "PATCH", event.path, { doors_open_at: doorsOpenedAnHourAgo() })).status, 200, "the door time moves (no admission yet)");
  assert.equal((await as("SELAM_OWNER", "PATCH", event.path, { registration_closes_at: new Date(Date.now() - 60_000).toISOString() })).status, 200, "sales closed");
  const vip = order.body.data.tickets.find((ticket: { ticket_type: { code: string } }) => ticket.ticket_type.code === "VIP") as { code: string };
  assert.equal((await as("SELAM_OWNER", "PATCH", `${event.path}/ticket-types/${event.types.VIP}/status`, { is_active: false })).status, 200, "VIP stopped");
  assert.equal((await gateScan("SELAM_OWNER", event.path, vip.code, randomUUID())).body.data.result, "ADMITTED", "issued VIP tickets still get in");
  const other = first?.code === vip.code ? second : first;
  assert.equal((await gateScan("SELAM_OWNER", event.path, other?.code as string, randomUUID())).body.data.result, "ADMITTED", "after the cutoff too");
});

test("row 104: a reschedule before the first admission keeps the tickets, codes and an explicit cutoff, texts each order once, sends nothing on a retry, and is refused after a scan", { skip }, async () => {
  resetPublicLimit();
  const friday = { starts_at: "2027-08-06T15:00:00+03:00", ends_at: "2027-08-06T22:00:00+03:00" };
  const sunday = { starts_at: "2027-08-08T15:00:00+03:00", ends_at: "2027-08-08T22:00:00+03:00" };
  const event = await publishedCheckoutEvent({ name: "Pilot Recital Two", registration_mode: "QUICK", ...friday, registration_closes_at: "2027-08-06T12:00:00+03:00" });
  const order = await as("SELAM_OWNER", "POST", `${event.path}/orders`, { buyer_mobile: "0913900002", items: [{ ticket_type_id: event.types.GA, quantity: 2 }] });
  const codes = order.body.data.tickets.map((ticket: { code: string }) => ticket.code).sort();

  assert.deepEqual((await as("SELAM_OWNER", "PATCH", event.path, { ends_at: "2027-08-07T22:00:00+03:00" })).body.error.details.issues[0].code, "schedule_pair_required", "the schedule moves as a whole");
  const moved = await as("SELAM_OWNER", "POST", `${event.path}/reschedule`, sunday);
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(new Date(moved.body.data.registration_closes_at).toISOString(), new Date("2027-08-06T12:00:00+03:00").toISOString(), "the explicit Friday cutoff stays");
  assert.equal(await MessageOutbox.count({ where: { kind: "EVENT_RESCHEDULED", order_id: order.body.data.id } }), 1);
  assert.equal((await as("SELAM_OWNER", "POST", `${event.path}/reschedule`, sunday)).status, 200);
  assert.equal(await MessageOutbox.count({ where: { kind: "EVENT_RESCHEDULED", order_id: order.body.data.id } }), 1, "the same change again sends nothing");
  const after = await as("SELAM_OWNER", "GET", `${event.path}/orders/${order.body.data.id}`);
  assert.deepEqual(after.body.data.tickets.map((ticket: { code: string }) => ticket.code).sort(), codes, "the same codes");

  const withDoors = await publishedCheckoutEvent({ name: "Pilot Gate Test", registration_mode: "QUICK", doors_open_at: doorsOpenedAnHourAgo() });
  assert.equal((await as("SELAM_OWNER", "POST", `${withDoors.path}/reschedule`, sunday)).body.error.details.issues[0].code, "doors_open_at_reconfirm");
  const ticket = (await as("SELAM_OWNER", "POST", `${withDoors.path}/orders`, { buyer_mobile: "0913900003", items: [{ ticket_type_id: withDoors.types.GA, quantity: 1 }] })).body.data.tickets[0] as { code: string };
  assert.equal((await gateScan("SELAM_OWNER", withDoors.path, ticket.code, randomUUID())).body.data.result, "ADMITTED");
  const tooLate = await as("SELAM_OWNER", "POST", `${withDoors.path}/reschedule`, { ...sunday, doors_open_at: null });
  assert.deepEqual([tooLate.status, tooLate.body.error.code], [409, "event_has_admissions"]);
});

test("row 105: capacity can't drop below confirmed tickets plus active holds (80 + 15): 90 is refused, 95 fits; the same at ticket-type level", { skip }, async () => {
  resetPublicLimit();
  stubChechePay();
  try {
    const event = await publishedCheckoutEvent({ name: "Pilot Hall", registration_mode: "QUICK", capacity: 200 }, [{ code: "VIP", name: "VIP", price: "100" }]);
    for (let index = 0; index < 4; index += 1) {
      const issued = await as("SELAM_OWNER", "POST", `${event.path}/orders`, { buyer_mobile: `09139100${10 + index}`, items: [{ ticket_type_id: event.types.GA, quantity: 20 }] });
      assert.equal(issued.status, 201, JSON.stringify(issued.body));
    }
    const holds = await postWithKey(`${event.publicPath}/orders`, orderForm([{ ticket_type_code: "VIP", quantity: 15 }], "0913910099"), randomUUID());
    assert.equal(holds.body.data.status, "PENDING_PAYMENT");
    const refused = await as("SELAM_OWNER", "PATCH", event.path, { capacity: 90 });
    assert.deepEqual([refused.status, refused.body.error.details], [409, { field: "capacity", confirmed: 80, held: 15, minimum: 95 }]);
    assert.equal((await as("SELAM_OWNER", "PATCH", event.path, { capacity: 95 })).status, 200);
    const vip = await as("SELAM_OWNER", "PATCH", `${event.path}/ticket-types/${event.types.VIP}`, { capacity: 10 });
    assert.deepEqual([vip.status, vip.body.error.details.minimum], [409, 15], "the held VIP places count at type level too");
  } finally {
    mock.restoreAll();
  }
});

test("row 106: stopping VIP keeps other types selling; a held VIP + 2 GA order paid on time gets all three; paid after its hold it gets none and one refund case", { skip }, async () => {
  resetPublicLimit();
  stubChechePay();
  try {
    const event = await publishedCheckoutEvent({ name: "Pilot Ball", registration_mode: "QUICK", doors_open_at: doorsOpenedAnHourAgo() }, [{ code: "VIP", name: "VIP", price: "1000" }]);
    assert.equal((await as("SELAM_OWNER", "PATCH", `${event.path}/ticket-types/${event.types.GA}`, { price: "500" })).status, 200);
    const items = [{ ticket_type_code: "VIP", quantity: 1 }, { ticket_type_code: "GA", quantity: 2 }];
    const onTime = await postWithKey(`${event.publicPath}/orders`, orderForm(items, "0913920001"), randomUUID());
    const late = await postWithKey(`${event.publicPath}/orders`, orderForm(items, "0913920002"), randomUUID());
    assert.equal((await as("SELAM_OWNER", "PATCH", `${event.path}/ticket-types/${event.types.VIP}/status`, { is_active: false })).status, 200);
    const vipNow = await postWithKey(`${event.publicPath}/orders`, orderForm([{ ticket_type_code: "VIP", quantity: 1 }], "0913920003"), randomUUID());
    assert.ok(vipNow.status >= 400, "no new VIP orders");
    assert.equal((await postWithKey(`${event.publicPath}/orders`, orderForm([{ ticket_type_code: "GA", quantity: 1 }], "0913920004"), randomUUID())).body.data.status, "PENDING_PAYMENT", "GA still sells");

    const onTimeRef = await txRefOf(onTime.body.data.reference);
    ledger.set(onTimeRef, { status: "SUCCEEDED", amount: "2000.00", succeededAt: new Date() });
    assert.equal((await signedWebhook(onTimeRef)).body.data.order_status, "CONFIRMED");
    const issued = await staffTicketsOf(event.path, onTime.body.data.reference);
    assert.deepEqual(issued.map((ticket) => ticket.status), ["CONFIRMED", "CONFIRMED", "CONFIRMED"], "all three at the original prices");
    const vipTicket = issued.find((ticket) => ticket.ticket_type.code === "VIP");
    assert.equal((await gateScan("SELAM_OWNER", event.path, vipTicket?.code as string, randomUUID())).body.data.result, "ADMITTED", "the stopped type's ticket still gets in");

    await TicketOrder.update({ hold_expires_at: new Date(Date.now() - 120_000) }, { where: { reference: late.body.data.reference } });
    const lateRef = await txRefOf(late.body.data.reference);
    ledger.set(lateRef, { status: "SUCCEEDED", amount: "2000.00", succeededAt: new Date(Date.now() - 60_000) });
    const refused = await signedWebhook(lateRef);
    assert.deepEqual([refused.body.data.order_status, refused.body.data.review_reason], ["REFUND_REQUIRED", "PAID_AFTER_DEADLINE"]);
    assert.equal((await staffTicketsOf(event.path, late.body.data.reference)).filter((ticket) => ticket.status === "CONFIRMED").length, 0);
    assert.equal(await PaymentCase.count({ where: { tx_ref: lateRef } }), 1);
  } finally {
    mock.restoreAll();
  }
});

// --- Phase 10: staff profiles and passwords (auth-cheche stubbed); the payment safety net (Cheche Pay stubbed) -------

const PROFILES = new Map<string, { userId: string; mobile: string | null; firstname: string | null; middlename: string | null; lastname: string | null; email: string | null; sex: string | null; date_of_birth: string | null }>();

/** auth-cheche's profiles as a map: reads come from it and edits change it, as the real service would. */
function stubProfiles() {
  PROFILES.clear();
  const read = mock.method(centralAuthClient, "getUserProfile", async (userId: string) => PROFILES.get(userId) ?? null);
  const update = mock.method(centralAuthClient, "updateUserProfile", async (userId: string, patch: Record<string, string | null | undefined>) => {
    const current = PROFILES.get(userId);
    assert.ok(current, "an unknown account");
    const sent = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined).map(([key, value]) => [key, value === "" ? null : value]));
    PROFILES.set(userId, { ...current, ...sent });
  });
  return { read, update };
}

test("row 107: an admin edits a staff member's names, email, sex and date of birth: only changed fields reach auth-cheche; never mobile, status, PIN or password; a refusal is 409; another organization can't", { skip }, async () => {
  const { update } = stubProfiles();
  mock.method(centralAuthClient, "getUsersByIds", async (ids: readonly string[]) => ids.map((userId) => ({ userId, mobile: null, firstname: "Name", middlename: null, lastname: "Of Staff" })));
  try {
    const viewerId = PEOPLE.SELAM_VIEWER;
    PROFILES.set(viewerId, { userId: viewerId, mobile: "+251933000107", firstname: "Meron", middlename: null, lastname: "Tadesse", email: "Meron@Example.et", sex: "FEMALE", date_of_birth: "1994-05-06" });
    const path = `${staffBase()}/staff-assignments/${await assignmentIdOf(PEOPLE.SELAM_VIEWER)}/profile`;

    const read = await as("SELAM_OWNER", "GET", path);
    assert.deepEqual([read.status, read.body.data.email, read.body.data.sex], [200, "Meron@Example.et", "FEMALE"]);

    const edited = await as("SELAM_OWNER", "PATCH", path, { firstname: "Meron", middlename: "Alemu", email: "meron@example.et", sex: "FEMALE", date_of_birth: "" });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.deepEqual(update.mock.calls[0]?.arguments, [viewerId, { middlename: "Alemu", date_of_birth: "" }], "the same first name, email (any case) and sex aren't sent");
    assert.deepEqual([edited.body.data.changed, edited.body.data.profile.middlename, edited.body.data.profile.date_of_birth], [true, "Alemu", null]);

    const unchanged = await as("SELAM_OWNER", "PATCH", path, { firstname: "Meron" });
    assert.deepEqual([unchanged.status, unchanged.body.data.changed, update.mock.callCount()], [200, false, 1], "nothing changed, nothing sent");

    for (const body of [{ mobile: "0933000999" }, { is_active: false }, { pin: "1234" }, { password: "new-secret-1" }, { sex: "OTHER" }]) {
      assert.equal((await as("SELAM_OWNER", "PATCH", path, body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await as("SELAM_VIEWER", "PATCH", path, { firstname: "X" })).status, 403, "needs Staff Assignments › update");
    // Horn is switched off by an earlier row, so another active organizer (Abay, as in row 82) checks the boundary.
    const abay = await Organization.findOne({ where: { name: "Abay Pilot" }, raw: true });
    assert.ok(abay);
    const fromAbay = await asToken(await tokenFor(ABAY_OWNER_ID), "PATCH", path.replace(fixture.selamId, abay.id), { firstname: "X" });
    assert.equal(fromAbay.status, 404, "another organization's assignment isn't found there");

    update.mock.mockImplementation(async () => {
      throw new CentralAuthRefusedError();
    });
    const refused = await as("SELAM_OWNER", "PATCH", path, { email: "other@example.et" });
    assert.deepEqual([refused.status, refused.body.error.code], [409, "central_auth_refused"], "auth-cheche saying no is a conflict, never a 401");
  } finally {
    mock.restoreAll();
  }
});

test("row 108: a staff member changes their own names and gets a token that carries them; changing the password checks the old one first", { skip }, async () => {
  authLoginLimiter.resetKey("127.0.0.1");
  stubProfiles();
  try {
    const ownerId = PEOPLE.SELAM_OWNER;
    const [assignment] = await userRoleRepository.listActiveAssignmentsByUser(ownerId);
    assert.ok(assignment);
    const mobile = "+251933000108";
    const token = authTokenService.signAppStaffToken({ userId: ownerId, assignment, profile: { mobile, firstname: "Selam", middlename: null, lastname: "Owner" } }).token;
    PROFILES.set(ownerId, { userId: ownerId, mobile, firstname: "Selam", middlename: null, lastname: "Owner", email: null, sex: null, date_of_birth: null });

    const renamed = await asToken(token, "PUT", "/v1/auth/staff/profile", { firstname: "Selamawit", lastname: "Owner" });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(PROFILES.get(ownerId)?.firstname, "Selamawit");
    const me = await asToken(renamed.body.data.access_token, "GET", "/v1/auth/staff/me");
    assert.deepEqual([me.status, me.body.data.user.firstname, me.body.data.assignment?.id ?? assignment.id], [200, "Selamawit", assignment.id], "the new token: same assignment, new names");

    const login = mock.method(centralAuthClient, "passwordLogin", async (input: { mobile: string; password: string }) => {
      if (input.password !== "old-secret") throw new InvalidCredentialsError();
      return { accessToken: "central-access-108", refreshToken: "central-refresh-108", refreshExpiresIn: null };
    });
    const changed = mock.method(centralAuthClient, "updatePassword", async (..._args: unknown[]) => undefined);
    const wrong = await asToken(token, "PUT", "/v1/auth/staff/password", { old_password: "not-it", new_password: "new-secret-1" });
    assert.deepEqual([wrong.status, wrong.body.error.details?.issues?.[0]?.code], [400, "wrong_password"]);
    assert.equal(changed.mock.callCount(), 0);
    const ok = await asToken(token, "PUT", "/v1/auth/staff/password", { old_password: "old-secret", new_password: "new-secret-1" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(login.mock.calls.at(-1)?.arguments[0], { mobile, password: "old-secret" });
    assert.deepEqual(changed.mock.calls[0]?.arguments, [ownerId, "central-access-108", "old-secret", "new-secret-1"]);
  } finally {
    mock.restoreAll();
  }
});

test("row 109: forgot password sends a code only to a mobile with an active staff assignment but always answers the same; the reset refuses a mobile without staff access", { skip }, async () => {
  authLoginLimiter.resetKey("127.0.0.1");
  const STAFF_MOBILE = "+251933000109";
  const GUEST_MOBILE = "+251933000110";
  const NOBODY_MOBILE = "+251933000111";
  for (const mobile of [STAFF_MOBILE, GUEST_MOBILE, NOBODY_MOBILE]) customerCodePerMobileLimiter.resetKey(`mobile:${mobile}`);
  const accounts = new Map([[STAFF_MOBILE, PEOPLE.SELAM_VIEWER], [GUEST_MOBILE, randomUUID()]]);
  mock.method(centralAuthClient, "findUserByMobile", async (mobile: string) => {
    const userId = accounts.get(mobile);
    return userId ? { userId, mobile, firstname: "A", middlename: null, lastname: "B" } : null;
  });
  const send = mock.method(centralAuthClient, "sendCode", async (_mobile: string) => undefined);
  const reset = mock.method(centralAuthClient, "resetPassword", async (_input: unknown) => undefined);
  try {
    const post = (path: string, body: unknown) => withServer(app, (baseUrl) => call(baseUrl, "POST", path, { body }));
    const replies = [];
    for (const mobile of ["0933000109", "0933000110", "0933000111"]) {
      const reply = await post("/v1/auth/staff/forgot-password", { mobile });
      assert.equal(reply.status, 200);
      replies.push(reply.body);
    }
    assert.deepEqual(replies[1], replies[0], "a guest gets the staff reply");
    assert.deepEqual(replies[2], replies[0], "so does an unknown mobile");
    assert.deepEqual(send.mock.calls.map((entry) => entry.arguments[0]), [STAFF_MOBILE], "the code goes to staff only");

    const refused = await post("/v1/auth/staff/reset-password", { mobile: "0933000110", otp: "123456", new_password: "new-secret-1" });
    assert.deepEqual([refused.status, refused.body.error.code, reset.mock.callCount()], [400, "invalid_code", 0]);
    const done = await post("/v1/auth/staff/reset-password", { mobile: "0933000109", otp: "123456", new_password: "new-secret-1" });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual(reset.mock.calls[0]?.arguments[0], { mobile: STAFF_MOBILE, otp: "123456", newPassword: "new-secret-1" });
  } finally {
    mock.restoreAll();
  }
});

test("row 110: the payment safety net: checkout gives Cheche Pay the callback and return addresses; at the hold's end the worker asks first, so a lost callback still issues tickets; an unreachable Cheche Pay still releases on time and is asked again later", { skip }, async () => {
  resetPublicLimit();
  const { initialize, verify } = stubChechePay();
  try {
    const event = await publishedCheckoutEvent({ name: "Pilot Safety Net", registration_mode: "QUICK" });
    assert.equal((await as("SELAM_OWNER", "PATCH", `${event.path}/ticket-types/${event.types.GA}`, { price: "300" })).status, 200);
    const buy = (mobile: string) => postWithKey(`${event.publicPath}/orders`, orderForm([{ ticket_type_code: "GA", quantity: 1 }], mobile), randomUUID());
    const lost = await buy("0913100101");
    const unpaid = await buy("0913100102");
    const offline = await buy("0913100103");
    for (const reply of [lost, unpaid, offline]) assert.equal(reply.status, 201, JSON.stringify(reply.body));

    const started = initialize.mock.calls.at(-1)?.arguments[0] as { callbackUrl: string | null; returnUrl: string | null };
    assert.equal(started.callbackUrl, `https://api.events.example.test/v1/payments/cheche/webhook/${fixture.selamId}`);
    assert.equal(started.returnUrl, `https://events.example.test/orders/${offline.body.data.reference}`);

    const lostRef = await txRefOf(lost.body.data.reference);
    const offlineRef = await txRefOf(offline.body.data.reference);
    ledger.set(lostRef, { status: "SUCCEEDED", amount: "300.00", succeededAt: new Date(Date.now() - 5 * 60_000) });
    let reachable = false;
    verify.mock.mockImplementation(async (_key: string, txRef: string) => {
      if (txRef === offlineRef && !reachable) throw new Error("Cheche Pay unreachable");
      const seen = ledger.get(txRef);
      return seen ? { status: seen.status, amount: seen.amount, currency: "ETB", isFinal: true, transactionId: "cp-1", succeededAt: seen.succeededAt ?? null, raw: {} } : null;
    });
    await TicketOrder.update({ hold_expires_at: new Date(Date.now() - 60_000) }, { where: { reference: [lost.body.data.reference, unpaid.body.data.reference, offline.body.data.reference] } });
    // The worker works in batches; other rows may leave due orders, so it runs until ours are done.
    for (let tick = 0; tick < 3; tick += 1) await paymentService.processDue(new Date());

    const statusOf = async (reference: string) => (await TicketOrder.findOne({ where: { reference }, raw: true }))?.status;
    assert.equal(await statusOf(lost.body.data.reference), "CONFIRMED", "paid on time, callback lost: tickets anyway");
    assert.equal(await Registration.count({ where: { order_id: (await TicketOrder.findOne({ where: { reference: lost.body.data.reference }, raw: true }))?.id, status: "CONFIRMED" } }), 1);
    assert.equal(await statusOf(unpaid.body.data.reference), "EXPIRED", "unpaid: released after asking");
    assert.equal(await statusOf(offline.body.data.reference), "EXPIRED", "Cheche Pay unreachable: still released on time");

    reachable = true;
    ledger.set(offlineRef, { status: "SUCCEEDED", amount: "300.00", succeededAt: new Date(Date.now() - 2 * 60_000) });
    for (let tick = 0; tick < 3; tick += 1) await paymentService.processDue(new Date());
    const settled = await OrderPayment.findOne({ where: { tx_ref: offlineRef }, raw: true });
    assert.equal(settled?.status, "PAID", "asked again once reachable: the payment is applied (tickets if the place is free, otherwise a refund case)");
    assert.ok(["CONFIRMED", "REFUND_REQUIRED"].includes((await statusOf(offline.body.data.reference)) as string));
  } finally {
    mock.restoreAll();
  }
});

// --- Phase 11: purchase-time pricing (price windows; Cheche Pay stubbed) ----------------------------------------

/** A window of minutes around now, as the API takes it. */
const windowFrom = (fromMinutes: number, toMinutes: number | null, price: string) => ({
  starts_at: new Date(Date.now() + fromMinutes * 60_000).toISOString(),
  ...(toMinutes === null ? {} : { ends_at: new Date(Date.now() + toMinutes * 60_000).toISOString() }),
  price,
});

async function setWindows(event: { path: string; types: Record<string, string> }, code: string, windows: unknown[]): Promise<TestResponse> {
  return as("SELAM_OWNER", "PATCH", `${event.path}/ticket-types/${event.types[code]}`, { price_windows: windows });
}

async function orderTotal(reference: string): Promise<string | undefined> {
  return (await TicketOrder.findOne({ where: { reference }, raw: true }))?.total_amount;
}

test("row 111: a hold made at 500 keeps 500 through a retry and payment after a 700 window starts; a fresh order for two then costs 1,400", { skip }, async () => {
  resetPublicLimit();
  stubChechePay();
  try {
    const event = await publishedCheckoutEvent({ name: "Pricing Sunset", registration_mode: "QUICK" });
    assert.equal((await as("SELAM_OWNER", "PATCH", `${event.path}/ticket-types/${event.types.GA}`, { price: "500" })).status, 200);
    const key = randomUUID();
    const form = orderForm([{ ticket_type_code: "GA", quantity: 2 }], "0913110001");
    const held = await postWithKey(`${event.publicPath}/orders`, form, key);
    assert.deepEqual([held.status, held.body.data.total_amount], [201, "1000.00"], "17:58: two at 500");

    const scheduled = await setWindows(event, "GA", [windowFrom(-0.1, 120, "700")]);
    assert.deepEqual([scheduled.status, scheduled.body.data.price, scheduled.body.data.effective_price], [200, "500.00", "700.00"], "18:00: the window starts");

    const retried = await postWithKey(`${event.publicPath}/orders`, form, key);
    assert.deepEqual([retried.status, retried.body.data.reference, retried.body.data.total_amount], [200, held.body.data.reference, "1000.00"], "18:03: the retry is the same order at 500");
    const txRef = await txRefOf(held.body.data.reference);
    ledger.set(txRef, { status: "SUCCEEDED", amount: "1000.00", succeededAt: new Date() });
    assert.equal((await signedWebhook(txRef)).body.data.order_status, "CONFIRMED", "paid within the hold at the 500 price");
    assert.deepEqual((await staffTicketsOf(event.path, held.body.data.reference)).map((ticket) => ticket.status), ["CONFIRMED", "CONFIRMED"]);

    const fresh = await postWithKey(`${event.publicPath}/orders`, orderForm([{ ticket_type_code: "GA", quantity: 2 }], "0913110002"), randomUUID());
    assert.deepEqual([fresh.status, fresh.body.data.total_amount], [201, "1400.00"], "a fresh order at 18:03 pays 700 each");
  } finally {
    mock.restoreAll();
  }
});

test("row 112: two GA in a 700 window and one fixed VIP at 1,200 come to 2,600; the public page shows 700 until the window ends, then 500 for a new order", { skip }, async () => {
  resetPublicLimit();
  stubChechePay();
  try {
    const event = await publishedCheckoutEvent({ name: "Pricing Gala", registration_mode: "QUICK" }, [{ code: "VIP", name: "VIP", price: "1200" }]);
    assert.equal((await as("SELAM_OWNER", "PATCH", `${event.path}/ticket-types/${event.types.GA}`, { price: "500" })).status, 200);
    assert.equal((await setWindows(event, "GA", [windowFrom(-0.1, 120, "700")])).status, 200);

    const page = await withServer(app, (baseUrl) => call(baseUrl, "GET", event.publicPath));
    const gaOnPage = page.body.data.ticket_types.find((type: { code: string }) => type.code === "GA");
    assert.deepEqual([gaOnPage.price, gaOnPage.is_free, typeof gaOnPage.price_valid_until], ["700.00", false, "string"]);

    const mixed = await postWithKey(`${event.publicPath}/orders`, orderForm([{ ticket_type_code: "GA", quantity: 2 }, { ticket_type_code: "VIP", quantity: 1 }], "0913120001"), randomUUID());
    assert.deepEqual([mixed.status, mixed.body.data.total_amount], [201, "2600.00"]);
    const prices = (await Registration.findAll({ where: { order_id: (await TicketOrder.findOne({ where: { reference: mixed.body.data.reference }, raw: true }))?.id }, raw: true }))
      .map((ticket) => ticket.price_amount)
      .sort();
    assert.deepEqual(prices, ["1200.00", "700.00", "700.00"]);

    // "20:00": the window is over (its end is excluded).
    assert.equal((await setWindows(event, "GA", [windowFrom(-120, -0.01, "700")])).status, 200);
    const after = await postWithKey(`${event.publicPath}/orders`, orderForm([{ ticket_type_code: "GA", quantity: 1 }], "0913120002"), randomUUID());
    assert.deepEqual([after.status, after.body.data.total_amount], [201, "500.00"]);
    assert.equal(await orderTotal(mixed.body.data.reference), "2600.00", "the earlier order keeps its total");
  } finally {
    mock.restoreAll();
  }
});

test("row 113: a free type with a positive window needs checkout during the window on both single-ticket paths; outside it the free rules apply", { skip }, async () => {
  resetPublicLimit();
  stubChechePay();
  try {
    const event = await publishedCheckoutEvent({ name: "Pricing Workshop", registration_mode: "QUICK" });
    assert.equal((await setWindows(event, "GA", [windowFrom(-0.1, 60, "300")])).status, 200);
    const publicForm = { ...workshopForm("Hana", "0913130001"), ticket_type_code: "GA" };
    const publicTry = await postWithKey(`${event.publicPath}/registrations`, publicForm, randomUUID());
    assert.deepEqual([publicTry.status, publicTry.body.error?.code, publicTry.body.error?.details?.price], [409, "payment_required", "300.00"]);
    const staffTry = await as("SELAM_OWNER", "POST", `${event.path}/registrations`, { person: { first_name: "Abel", last_name: "Free", phone: "0913130002" }, ticket_type_id: event.types.GA });
    assert.deepEqual([staffTry.status, staffTry.body.error?.code], [409, "payment_required"]);
    const order = await postWithKey(`${event.publicPath}/orders`, orderForm([{ ticket_type_code: "GA", quantity: 1 }], "0913130003"), randomUUID());
    assert.deepEqual([order.body.data.status, order.body.data.total_amount], ["PENDING_PAYMENT", "300.00"], "checkout sells it at 300");

    assert.equal((await setWindows(event, "GA", [windowFrom(60, 120, "300")])).status, 200, "the window moves later");
    const free = await postWithKey(`${event.publicPath}/registrations`, { ...publicForm, ...workshopForm("Selam", "0913130004"), ticket_type_code: "GA" }, randomUUID());
    assert.equal(free.status, 201, JSON.stringify(free.body));
  } finally {
    mock.restoreAll();
  }
});

test("row 114: editing the active window while a buyer holds one ticket at 700 keeps the hold at 700; paid and later returned, the refund is 700", { skip }, async () => {
  resetPublicLimit();
  stubChechePay();
  try {
    const event = await publishedCheckoutEvent({ name: "Pricing Concert", registration_mode: "QUICK" });
    assert.equal((await as("SELAM_OWNER", "PATCH", `${event.path}/ticket-types/${event.types.GA}`, { price: "500" })).status, 200);
    assert.equal((await setWindows(event, "GA", [windowFrom(-0.1, 120, "700")])).status, 200);
    const held = await postWithKey(`${event.publicPath}/orders`, orderForm([{ ticket_type_code: "GA", quantity: 1 }], "0913140001"), randomUUID());
    assert.equal(held.body.data.total_amount, "700.00");

    const edited = await setWindows(event, "GA", [windowFrom(-0.1, 120, "900")]);
    assert.equal(edited.body.data.effective_price, "900.00");
    const txRef = await txRefOf(held.body.data.reference);
    ledger.set(txRef, { status: "SUCCEEDED", amount: "700.00", succeededAt: new Date() });
    assert.equal((await signedWebhook(txRef)).body.data.order_status, "CONFIRMED", "700 is the order's amount, whatever the window says now");

    assert.equal((await setWindows(event, "GA", [])).status, 200, "the schedule is cleared: GA is 500 again");
    const [ticket] = await staffTicketsOf(event.path, held.body.data.reference);
    const returned = await as("SELAM_OWNER", "POST", `${event.path}/registrations/${ticket?.id}/return`);
    assert.deepEqual([returned.status, returned.body.data.refund_case?.amount], [200, "700.00"], "the price paid, not today's");
  } finally {
    mock.restoreAll();
  }
});

test("row 115: overlapping windows, or another organization's ticket type, are refused as a whole; the old schedule keeps pricing checkout", { skip }, async () => {
  resetPublicLimit();
  stubChechePay();
  try {
    const event = await publishedCheckoutEvent({ name: "Pricing Forum", registration_mode: "QUICK" });
    assert.equal((await as("SELAM_OWNER", "PATCH", `${event.path}/ticket-types/${event.types.GA}`, { price: "500" })).status, 200);
    assert.equal((await setWindows(event, "GA", [windowFrom(-0.1, 120, "700")])).status, 200);

    const overlapping = await setWindows(event, "GA", [windowFrom(-0.1, 60, "800"), windowFrom(30, 90, "900")]);
    assert.deepEqual([overlapping.status, overlapping.body.error.details.issues[0].code], [400, "overlapping_window"]);
    const twoOpen = await setWindows(event, "GA", [windowFrom(-0.1, null, "800"), windowFrom(30, null, "900")]);
    assert.deepEqual([twoOpen.status, twoOpen.body.error.details.issues[0].code], [400, "overlapping_window"]);

    const abay = await Organization.findOne({ where: { name: "Abay Pilot" }, raw: true });
    assert.ok(abay);
    const foreign = await asToken(await tokenFor(ABAY_OWNER_ID), "PATCH", `${event.path.replace(fixture.selamId, abay.id)}/ticket-types/${event.types.GA}`, { price_windows: [windowFrom(-0.1, 60, "1")] });
    assert.equal(foreign.status, 404, "another organization's ticket type isn't found there");

    const listed = (await as("SELAM_OWNER", "GET", `${event.path}/ticket-types`)).body.data.find((type: { code: string }) => type.code === "GA");
    assert.deepEqual(listed.price_windows.map((window: { price: string }) => window.price), ["700.00"], "the old schedule stands");
    const order = await postWithKey(`${event.publicPath}/orders`, orderForm([{ ticket_type_code: "GA", quantity: 1 }], "0913150001"), randomUUID());
    assert.equal(order.body.data.total_amount, "700.00");
  } finally {
    mock.restoreAll();
  }
});
