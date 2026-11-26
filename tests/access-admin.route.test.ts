import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { createApp } from "../src/app.js";
import { moduleService } from "../src/services/module.service.js";
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
    for (const body of [{}, { overrides: [{ module_code: "EVENTS", view: "yes" }] }, { overrides: [{ module_code: "EVENTS", delete: true }] }, { overrides: [{ module_code: "EVENTS" }, { module_code: "EVENTS" }] }]) {
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
