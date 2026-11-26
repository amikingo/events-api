import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { createApp } from "../src/app.js";
import { moduleService } from "../src/services/module.service.js";
import { roleService } from "../src/services/role.service.js";
import { permissionResolutionService, type PermissionScope } from "../src/services/permission-resolution.service.js";
import { roleTemplateService } from "../src/services/role-template.service.js";
import { staffAssignmentService } from "../src/services/staff-assignment.service.js";
import { IDS, staffToken } from "./helpers/fixtures.js";
import { call, withServer } from "./helpers/http.js";

/**
 * Access control administration (Phase 2d) over HTTP: real auth, validation and envelope; the permission engine and
 * the services are stubbed. Checks each route's module, action and scope.
 */
const app = createApp();
const ASSIGNMENT = "66666666-6666-4666-8666-666666666662";
const TEMPLATE = "77777777-7777-4777-8777-777777777772";
const MODULE = "77777777-7777-4777-8777-777777777773";
const staffPath = `/v1/organizations/${IDS.orgA}/staff-assignments/${ASSIGNMENT}/overrides`;

function allowPermissions(allowed: boolean) {
  return mock.method(permissionResolutionService, "resolvePermission", async (input: { scope: PermissionScope }) => ({
    allowed,
    source: allowed ? ("role_permission" as const) : ("default_deny" as const),
    scope: input.scope,
    roleIds: [],
  }));
}

afterEach(() => mock.restoreAll());

test("overrides use Staff Assignments in the organization; templates and modules are platform scope; Owners read templates with Roles › create", async () => {
  const permission = allowPermissions(false);
  await withServer(app, async (baseUrl) => {
    const token = staffToken();
    assert.equal((await call(baseUrl, "GET", staffPath)).status, 401, "no token");
    await call(baseUrl, "GET", staffPath, { token });
    await call(baseUrl, "PUT", staffPath, { token, body: { overrides: [] } });
    await call(baseUrl, "GET", `/v1/organizations/${IDS.orgA}/role-templates`, { token });
    await call(baseUrl, "GET", "/v1/role-templates", { token });
    await call(baseUrl, "POST", "/v1/role-templates", { token, body: { code: "GATE", name: "Gate", grants: [] } });
    await call(baseUrl, "PATCH", `/v1/role-templates/${TEMPLATE}`, { token, body: { name: "Gate 2" } });
    await call(baseUrl, "PATCH", `/v1/role-templates/${TEMPLATE}/status`, { token, body: { is_active: false } });
    await call(baseUrl, "GET", "/v1/modules", { token });
    const denied = await call(baseUrl, "PATCH", `/v1/modules/${MODULE}`, { token, body: { sno: 2 } });
    assert.deepEqual([denied.status, denied.body.error.code], [403, "permission_denied"]);
  });

  const requested = permission.mock.calls.map((entry) => entry.arguments[0] as { moduleCode: string; action: string; scope: PermissionScope });
  const organization = { level: "organization", organizationId: IDS.orgA, branchId: null };
  const platform = { level: "platform" };
  assert.deepEqual(
    requested.map((input) => [input.moduleCode, input.action, input.scope]),
    [
      ["USER_ROLES", "view", organization],
      ["USER_ROLES", "update", organization],
      ["ROLES", "create", organization],
      ["ROLE_TEMPLATES", "view", platform],
      ["ROLE_TEMPLATES", "create", platform],
      ["ROLE_TEMPLATES", "update", platform],
      ["ROLE_TEMPLATES", "update", platform],
      ["MODULES", "view", platform],
      ["MODULES", "update", platform],
    ],
  );
});

test("bodies are strict: an override box is true, false or null; a module's code or route can't be sent; nothing invalid reaches a service", async () => {
  allowPermissions(true);
  const replace = mock.method(staffAssignmentService, "replaceOverrides", async () => ({ assignment_id: ASSIGNMENT, role: { id: "r", code: "VIEWER", name: "Viewer" }, overridable: true, modules: [] }));
  const update = mock.method(moduleService, "updateModule", async () => ({}) as never);
  const create = mock.method(roleTemplateService, "createTemplate", async () => ({}) as never);

  await withServer(app, async (baseUrl) => {
    const token = staffToken();
    for (const body of [{}, { overrides: [{ module_code: "EVENTS", view: "yes" }] }, { overrides: [{ module_code: "EVENTS", approve: true }] }, { overrides: [{ module_code: "EVENTS" }, { module_code: "EVENTS" }] }]) {
      assert.equal((await call(baseUrl, "PUT", staffPath, { token, body })).status, 400, JSON.stringify(body));
    }
    for (const body of [{}, { code: "NEW" }, { route_name: "/x" }, { is_active: false }, { icon: "not an icon!" }, { sno: -1 }]) {
      assert.equal((await call(baseUrl, "PATCH", `/v1/modules/${MODULE}`, { token, body })).status, 400, JSON.stringify(body));
    }
    assert.equal((await call(baseUrl, "POST", "/v1/role-templates", { token, body: { code: "bad code", name: "X", grants: [] } })).status, 400);

    const saved = await call(baseUrl, "PUT", staffPath, { token, body: { overrides: [{ module_code: "events", export: null, view: false }] } });
    assert.deepEqual([saved.status, saved.body.message], [200, "Permission overrides saved"]);
  });

  assert.equal(update.mock.callCount(), 0);
  assert.equal(create.mock.callCount(), 0);
  const [organizationId, assignmentId, input, editor] = replace.mock.calls[0]?.arguments as unknown as [string, string, { overrides: unknown[] }, unknown];
  assert.deepEqual([organizationId, assignmentId], [IDS.orgA, ASSIGNMENT]);
  assert.deepEqual(input.overrides, [{ module_code: "EVENTS", export: null, view: false }], "codes are upper-cased");
  assert.deepEqual(editor, { userId: IDS.user, assignmentId: IDS.assignment }, "the editor is the signed-in assignment");
});

test("a role change with overrides left says so in the message", async () => {
  allowPermissions(true);
  mock.method(staffAssignmentService, "update", async () => ({ id: ASSIGNMENT, role_changed: true, override_count: 2 }) as never);
  await withServer(app, async (baseUrl) => {
    const response = await call(baseUrl, "PATCH", `/v1/organizations/${IDS.orgA}/staff-assignments/${ASSIGNMENT}`, {
      token: staffToken(),
      body: { role_id: "55555555-5555-4555-8555-555555555552" },
    });
    assert.deepEqual([response.status, response.body.message, response.body.data.override_count], [
      200,
      "Role changed. This person still has 2 permission overrides: review them.",
      2,
    ]);
  });
});

test("one assignment is read with Staff Assignments › view; the list's role and branch filters must be ids", async () => {
  const permission = allowPermissions(true);
  const get = mock.method(staffAssignmentService, "get", async () => ({ id: ASSIGNMENT }) as never);
  const list = mock.method(staffAssignmentService, "list", async (_o: string, _query: unknown) => ({ rows: [], count: 0 }));
  await withServer(app, async (baseUrl) => {
    const token = staffToken();
    assert.equal((await call(baseUrl, "GET", `/v1/organizations/${IDS.orgA}/staff-assignments/${ASSIGNMENT}`, { token })).status, 200);
    assert.equal((await call(baseUrl, "GET", `/v1/organizations/${IDS.orgA}/staff-assignments?role_id=nope`, { token })).status, 400);
    assert.equal((await call(baseUrl, "GET", `/v1/organizations/${IDS.orgA}/staff-assignments?role_id=${TEMPLATE}&branch_id=${MODULE}`, { token })).status, 200);
  });
  assert.deepEqual(get.mock.calls[0]?.arguments, [IDS.orgA, ASSIGNMENT]);
  const [, query] = list.mock.calls[0]?.arguments ?? [];
  assert.deepEqual([(query as { role_id: string }).role_id, (query as { branch_id: string }).branch_id], [TEMPLATE, MODULE]);
  const first = permission.mock.calls[0]?.arguments[0] as { moduleCode: string; action: string };
  assert.deepEqual([first.moduleCode, first.action], ["USER_ROLES", "view"]);
});

test("the grantable modules list takes Roles › view or Staff Assignments › view; deleting an assignment needs Staff Assignments › delete and answers 204", async () => {
  const permission = mock.method(permissionResolutionService, "resolvePermission", async (input: { moduleCode: string; action: string; scope: PermissionScope }) => ({
    allowed: input.moduleCode === "USER_ROLES",
    source: "role_permission" as const,
    scope: input.scope,
    roleIds: [],
  }));
  mock.method(roleService, "listGrantableModules", async () => []);
  const remove = mock.method(staffAssignmentService, "remove", async (_o: string, _id: string, _actor: string | null) => undefined);

  await withServer(app, async (baseUrl) => {
    const token = staffToken();
    const listed = await call(baseUrl, "GET", `/v1/organizations/${IDS.orgA}/grantable-modules`, { token });
    assert.equal(listed.status, 200, "Staff Assignments › view is enough");
    const deleted = await call(baseUrl, "DELETE", `/v1/organizations/${IDS.orgA}/staff-assignments/${ASSIGNMENT}`, { token });
    assert.equal(deleted.status, 204);
  });

  const asked = permission.mock.calls.map((entry) => [entry.arguments[0].moduleCode, entry.arguments[0].action]);
  assert.deepEqual(asked, [
    ["ROLES", "view"],
    ["USER_ROLES", "view"],
    ["USER_ROLES", "delete"],
  ]);
  assert.deepEqual(remove.mock.calls[0]?.arguments, [IDS.orgA, ASSIGNMENT, IDS.user]);
});

test("editing names needs Staff Assignments › update and takes names only; a new account's password must be 8 or more characters", async () => {
  const permission = allowPermissions(true);
  const rename = mock.method(staffAssignmentService, "updateProfile", async () => ({ id: ASSIGNMENT }) as never);
  const assign = mock.method(staffAssignmentService, "assign", async () => ({ assignment: { id: ASSIGNMENT } as never, outcome: "CREATED" as const, accountCreated: true }));
  await withServer(app, async (baseUrl) => {
    const token = staffToken();
    const path = `/v1/organizations/${IDS.orgA}/staff-assignments/${ASSIGNMENT}/profile`;
    for (const body of [{}, { mobile: "0911223344" }, { firstname: "Hana", email: "h@x.et" }, { password: "secret-123" }]) {
      assert.equal((await call(baseUrl, "PATCH", path, { token, body })).status, 400, JSON.stringify(body));
    }
    assert.equal((await call(baseUrl, "PATCH", path, { token, body: { firstname: "Hanna" } })).status, 200);

    const add = `/v1/organizations/${IDS.orgA}/staff-assignments`;
    const role_id = "55555555-5555-4555-8555-555555555552";
    const short = await call(baseUrl, "POST", add, { token, body: { mobile: "0911223344", role_id, new_account: { firstname: "H", lastname: "B", password: "short" } } });
    assert.equal(short.status, 400);
    const created = await call(baseUrl, "POST", add, { token, body: { mobile: "0911223344", role_id, new_account: { firstname: "H", lastname: "B", password: "long-enough" } } });
    assert.deepEqual([created.status, created.body.data.account_created, created.body.message], [201, true, "Cheche account created. Staff assignment created"]);
    assert.ok(!JSON.stringify(created.body).includes("long-enough"), "the password is never returned");
  });
  assert.equal(rename.mock.callCount(), 1);
  assert.equal(assign.mock.callCount(), 1);
  const asked = permission.mock.calls.map((entry) => [(entry.arguments[0] as { moduleCode: string }).moduleCode, (entry.arguments[0] as { action: string }).action]);
  assert.deepEqual(asked[0], ["USER_ROLES", "update"]);
});

test("platform roles use Roles and platform staff use Staff Assignments, both at platform scope; bodies are strict", async () => {
  const permission = allowPermissions(false);
  await withServer(app, async (baseUrl) => {
    const token = staffToken();
    const role = "55555555-5555-4555-8555-555555555553";
    await call(baseUrl, "GET", "/v1/platform/roles", { token });
    await call(baseUrl, "POST", "/v1/platform/roles", { token, body: { code: "HELP", name: "Help", grants: [] } });
    await call(baseUrl, "PATCH", `/v1/platform/roles/${role}/status`, { token, body: { is_active: false } });
    await call(baseUrl, "GET", "/v1/platform/staff-assignments", { token });
    await call(baseUrl, "POST", "/v1/platform/staff-assignments", { token, body: { mobile: "0911223344", role_id: role } });
    const denied = await call(baseUrl, "DELETE", `/v1/platform/staff-assignments/${ASSIGNMENT}`, { token });
    assert.deepEqual([denied.status, denied.body.error.code], [403, "permission_denied"]);
    assert.equal((await call(baseUrl, "POST", "/v1/platform/staff-assignments", { token, body: { mobile: "0911223344", role_id: role, organization_id: IDS.orgA } })).status, 400);
  });
  const asked = permission.mock.calls.map((entry) => {
    const input = entry.arguments[0] as { moduleCode: string; action: string; scope: PermissionScope };
    return [input.moduleCode, input.action, input.scope.level];
  });
  assert.deepEqual(asked, [
    ["ROLES", "view", "platform"],
    ["ROLES", "create", "platform"],
    ["ROLES", "update", "platform"],
    ["USER_ROLES", "view", "platform"],
    ["USER_ROLES", "create", "platform"],
    ["USER_ROLES", "delete", "platform"],
  ]);
});
