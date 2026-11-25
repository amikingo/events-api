import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { createApp } from "../src/app.js";
import type { RoleDto } from "../src/mappers/staff.mapper.js";
import { organizationService } from "../src/services/organization.service.js";
import { permissionResolutionService, type PermissionScope } from "../src/services/permission-resolution.service.js";
import { roleService, type RoleEditor } from "../src/services/role.service.js";
import type { RoleCreateInput, RoleUpdateInput } from "../src/validators/role.js";
import { IDS, organizationRow, staffToken } from "./helpers/fixtures.js";
import { call, withServer } from "./helpers/http.js";

/** HTTP-level tests of the Phase 2c role and organization endpoints: real auth, validation and envelope; services stubbed. */
const app = createApp();
const base = `/v1/organizations/${IDS.orgA}`;
const ROLE: RoleDto = { id: IDS.roleA, code: "DOOR_STAFF", name: "Door staff", description: null, is_active: true, grants: [] };
const GRANT = { module_code: "registrations", view: true, create: false, update: true };

function allowPermissions(allowed: boolean) {
  return mock.method(permissionResolutionService, "resolvePermission", async (input: { scope: PermissionScope }) => ({
    allowed,
    source: allowed ? ("role_permission" as const) : ("default_deny" as const),
    scope: input.scope,
    roleIds: [],
  }));
}

afterEach(() => mock.restoreAll());

test("role writes use ROLES create and update in the organization; organization status uses platform-scope ORGANIZATIONS update", async () => {
  const permission = allowPermissions(false);

  await withServer(app, async (baseUrl) => {
    assert.equal((await call(baseUrl, "POST", `${base}/roles`, { body: { code: "X", name: "X", grants: [] } })).status, 401, "no token");
    const token = staffToken();
    const denied = await call(baseUrl, "POST", `${base}/roles`, { token, body: { code: "GATE", name: "Gate", grants: [GRANT] } });
    assert.deepEqual([denied.status, denied.body.error.code], [403, "permission_denied"]);
    await call(baseUrl, "GET", `${base}/roles/${IDS.roleA}`, { token });
    await call(baseUrl, "PATCH", `${base}/roles/${IDS.roleA}`, { token, body: { name: "Gate" } });
    await call(baseUrl, "PATCH", `${base}/roles/${IDS.roleA}/status`, { token, body: { is_active: false } });
    await call(baseUrl, "PATCH", `${base}/status`, { token, body: { is_active: false } });
  });

  const requested = permission.mock.calls.map((entry) => entry.arguments[0] as { moduleCode: string; action: string; scope: PermissionScope });
  assert.deepEqual(
    requested.map((input) => [input.moduleCode, input.action]),
    [
      ["ROLES", "create"],
      ["ROLES", "view"],
      ["ROLES", "update"],
      ["ROLES", "update"],
      ["ORGANIZATIONS", "update"],
    ],
  );
  const organizationScope = { level: "organization", organizationId: IDS.orgA, branchId: null };
  for (const input of requested.slice(0, 4)) assert.deepEqual(input.scope, organizationScope);
  assert.deepEqual(requested[4]?.scope, { level: "platform" }, "an Owner can never switch their own organization off");
});

test("creating a role: 201 with the editor's user and assignment; codes are upper-cased; bad bodies are 400", async () => {
  allowPermissions(true);
  const create = mock.method(roleService, "createRole", async (_o: string, _input: RoleCreateInput, _editor: RoleEditor) => ROLE);

  await withServer(app, async (baseUrl) => {
    const token = staffToken();
    for (const body of [
      { code: "GATE", name: "Gate" },
      { code: "GATE", name: "Gate", grants: [{ ...GRANT, delete: true }] },
      { code: "GATE", name: "Gate", grants: [GRANT, GRANT] },
      { code: "gate keeper", name: "Gate", grants: [] },
      { code: "GATE", name: "", grants: [] },
      { code: "GATE", name: "Gate", grants: [], organization_id: IDS.orgB },
    ]) {
      assert.equal((await call(baseUrl, "POST", `${base}/roles`, { token, body })).status, 400, JSON.stringify(body));
    }
    const created = await call(baseUrl, "POST", `${base}/roles`, { token, body: { code: "door_staff", name: "Door staff", grants: [GRANT] } });
    assert.deepEqual([created.status, created.body.data.code, created.body.message], [201, "DOOR_STAFF", "Role created"]);
  });

  const [organizationId, input, editor] = create.mock.calls[0]?.arguments ?? [];
  assert.deepEqual([organizationId, input?.code, input?.grants[0]?.module_code], [IDS.orgA, "DOOR_STAFF", "REGISTRATIONS"]);
  assert.deepEqual(editor, { userId: IDS.user, assignmentId: IDS.assignment });
});

test("editing a role needs at least one field; switching it needs is_active; the code can't be changed", async () => {
  allowPermissions(true);
  const update = mock.method(roleService, "updateRole", async (_o: string, _r: string, _input: RoleUpdateInput, _editor: RoleEditor) => ROLE);
  const status = mock.method(roleService, "changeRoleStatus", async (_o: string, _r: string, _active: boolean, _editor: RoleEditor) => ROLE);

  await withServer(app, async (baseUrl) => {
    const token = staffToken();
    assert.equal((await call(baseUrl, "PATCH", `${base}/roles/${IDS.roleA}`, { token, body: {} })).status, 400);
    assert.equal((await call(baseUrl, "PATCH", `${base}/roles/${IDS.roleA}`, { token, body: { code: "OTHER" } })).status, 400);
    assert.equal((await call(baseUrl, "PATCH", `${base}/roles/not-a-uuid`, { token, body: { name: "X" } })).status, 400);
    assert.equal((await call(baseUrl, "PATCH", `${base}/roles/${IDS.roleA}/status`, { token, body: {} })).status, 400);
    assert.equal((await call(baseUrl, "PATCH", `${base}/roles/${IDS.roleA}`, { token, body: { grants: [] } })).status, 200, "an empty set removes every grant");
    assert.equal((await call(baseUrl, "PATCH", `${base}/roles/${IDS.roleA}/status`, { token, body: { is_active: false } })).status, 200);
  });

  assert.deepEqual(update.mock.calls[0]?.arguments.slice(0, 3), [IDS.orgA, IDS.roleA, { grants: [] }]);
  assert.deepEqual(status.mock.calls[0]?.arguments.slice(0, 3), [IDS.orgA, IDS.roleA, false]);
});

test("organizations: name and description are editable, the slug is not; status switches; owner_mobile must be Ethiopian", async () => {
  allowPermissions(true);
  const settings = mock.method(organizationService, "updateOrganizationSettings", async () => organizationRow({ name: "Renamed" }));
  const status = mock.method(organizationService, "changeOrganizationStatus", async (_id: string, _active: boolean, _actor: string | null) =>
    organizationRow({ is_active: false }),
  );
  const create = mock.method(organizationService, "createOrganization", async () => ({ organization: organizationRow(), branches: [], owner: null }));

  await withServer(app, async (baseUrl) => {
    const token = staffToken();
    assert.equal((await call(baseUrl, "PATCH", base, { token, body: { name: "Renamed", description: null } })).status, 200);
    assert.equal((await call(baseUrl, "PATCH", base, { token, body: { slug: "renamed" } })).status, 400);
    const off = await call(baseUrl, "PATCH", `${base}/status`, { token, body: { is_active: false } });
    assert.deepEqual([off.status, off.body.data.is_active, off.body.message], [200, false, "Organization switched off"]);
    const badMobile = await call(baseUrl, "POST", "/v1/organizations", { token, body: { organization: { name: "Pilot Org" }, owner_mobile: "+44 20 7946 0958" } });
    assert.equal(badMobile.status, 400);
    const created = await call(baseUrl, "POST", "/v1/organizations", { token, body: { organization: { name: "Pilot Org" }, owner_mobile: "0911 234 567" } });
    assert.equal(created.status, 201);
  });

  assert.equal(settings.mock.callCount(), 1);
  assert.deepEqual(status.mock.calls[0]?.arguments, [IDS.orgA, false, IDS.user]);
  const [createBody] = (create.mock.calls[0]?.arguments ?? []) as unknown as [{ owner_mobile?: string }];
  assert.equal(createBody.owner_mobile, "+251911234567", "normalized before the service sees it");
});
