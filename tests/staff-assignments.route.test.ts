import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { createApp } from "../src/app.js";
import type { StaffAssignmentDto } from "../src/mappers/staff.mapper.js";
import { permissionResolutionService, type PermissionScope } from "../src/services/permission-resolution.service.js";
import { roleService } from "../src/services/role.service.js";
import { staffAssignmentService } from "../src/services/staff-assignment.service.js";
import { IDS, staffToken } from "./helpers/fixtures.js";
import { call, withServer } from "./helpers/http.js";

/** HTTP-level tests of the roles and staff-assignment routes: real auth, validation and envelope; services stubbed. */
const app = createApp();
const base = `/v1/organizations/${IDS.orgA}`;
const DTO: StaffAssignmentDto = {
  id: IDS.assignment,
  user_id: IDS.user,
  is_active: true,
  role: { id: IDS.roleA, code: "VIEWER", name: "Viewer" },
  branch: null,
  profile: { firstname: "Hana", middlename: null, lastname: "Bekele", mobile: "+251911234567" },
  created_at: new Date("2026-11-26T08:00:00Z"),
  updated_at: new Date("2026-11-26T08:00:00Z"),
};

function allowPermissions(allowed: boolean) {
  return mock.method(permissionResolutionService, "resolvePermission", async (input: { scope: PermissionScope }) => ({
    allowed,
    source: allowed ? ("role_permission" as const) : ("default_deny" as const),
    scope: input.scope,
    roleIds: [],
  }));
}

afterEach(() => mock.restoreAll());

test("roles use ROLES view; staff assignments use USER_ROLES view, create (and the lookup) and update", async () => {
  const permission = allowPermissions(false);

  await withServer(app, async (baseUrl) => {
    assert.equal((await call(baseUrl, "GET", `${base}/staff-assignments`)).status, 401, "no token");
    const token = staffToken();
    await call(baseUrl, "GET", `${base}/roles`, { token });
    await call(baseUrl, "GET", `${base}/staff-assignments`, { token });
    await call(baseUrl, "GET", `${base}/staff-lookup?mobile=0911234567`, { token });
    await call(baseUrl, "POST", `${base}/staff-assignments`, { token, body: { mobile: "0911234567", role_id: IDS.roleA } });
    const denied = await call(baseUrl, "PATCH", `${base}/staff-assignments/${IDS.assignment}/status`, { token, body: { is_active: false } });
    assert.deepEqual([denied.status, denied.body.error.code], [403, "permission_denied"]);
  });

  const requested = permission.mock.calls.map((entry) => entry.arguments[0] as { moduleCode: string; action: string; scope: PermissionScope });
  assert.deepEqual(
    requested.map((input) => [input.moduleCode, input.action]),
    [
      ["ROLES", "view"],
      ["USER_ROLES", "view"],
      ["USER_ROLES", "create"],
      ["USER_ROLES", "create"],
      ["USER_ROLES", "update"],
    ],
  );
  for (const input of requested) assert.deepEqual(input.scope, { level: "organization", organizationId: IDS.orgA, branchId: null });
});

test("adding staff takes an Ethiopian mobile and a role id, never a user id; 201 when given, 200 when they already had it", async () => {
  allowPermissions(true);
  const outcomes = ["CREATED", "UNCHANGED"] as const;
  let index = 0;
  const assign = mock.method(
    staffAssignmentService,
    "assign",
    async (_organizationId: string, _input: { mobile: string; role_id: string }, _actorId: string | null) => ({
      assignment: DTO,
      outcome: outcomes[index++] ?? "CREATED",
    }),
  );

  await withServer(app, async (baseUrl) => {
    const token = staffToken();
    for (const body of [
      { mobile: "+44 20 7946 0958", role_id: IDS.roleA },
      { mobile: "0911234567" },
      { mobile: "0911234567", role_id: IDS.roleA, user_id: IDS.user },
    ]) {
      assert.equal((await call(baseUrl, "POST", `${base}/staff-assignments`, { token, body })).status, 400, JSON.stringify(body));
    }
    const created = await call(baseUrl, "POST", `${base}/staff-assignments`, { token, body: { mobile: "0911 234 567", role_id: IDS.roleA } });
    assert.deepEqual([created.status, created.body.data.profile.firstname], [201, "Hana"]);
    const again = await call(baseUrl, "POST", `${base}/staff-assignments`, { token, body: { mobile: "0911234567", role_id: IDS.roleA } });
    assert.deepEqual([again.status, again.body.message], [200, "This person already has this role"]);
  });

  const [organizationId, input, actorId] = assign.mock.calls[0]?.arguments ?? [];
  assert.deepEqual([organizationId, input?.mobile, actorId], [IDS.orgA, "+251911234567", IDS.user]);
});

test("the lookup, list, role read and updates reach their services with normalized input", async () => {
  allowPermissions(true);
  const lookUp = mock.method(staffAssignmentService, "lookUp", async (_mobile: string) => ({
    user_id: IDS.user,
    firstname: "Hana",
    middlename: null,
    lastname: "Bekele",
    mobile: "+251911234567",
  }));
  mock.method(staffAssignmentService, "list", async () => ({ rows: [DTO], count: 1 }));
  const update = mock.method(
    staffAssignmentService,
    "update",
    async (_o: string, _id: string, _input: { role_id?: string; branch_id?: string | null }, _actor: string | null) => DTO,
  );
  mock.method(roleService, "listRoles", async () => []);

  await withServer(app, async (baseUrl) => {
    const token = staffToken();
    assert.equal((await call(baseUrl, "GET", `${base}/staff-lookup?mobile=0911234567`, { token })).body.data.firstname, "Hana");
    assert.equal((await call(baseUrl, "GET", `${base}/staff-lookup?mobile=12`, { token })).status, 400);
    assert.equal((await call(baseUrl, "GET", `${base}/staff-assignments?is_active=true`, { token })).body.meta.count, 1);
    assert.equal((await call(baseUrl, "GET", `${base}/roles`, { token })).status, 200);
    assert.equal((await call(baseUrl, "PATCH", `${base}/staff-assignments/${IDS.assignment}`, { token, body: {} })).status, 400, "nothing to change");
    assert.equal((await call(baseUrl, "PATCH", `${base}/staff-assignments/${IDS.assignment}`, { token, body: { branch_id: null } })).status, 200);
  });

  assert.deepEqual(lookUp.mock.calls[0]?.arguments, ["+251911234567"]);
  assert.deepEqual(update.mock.calls[0]?.arguments.slice(0, 3), [IDS.orgA, IDS.assignment, { branch_id: null }]);
});
