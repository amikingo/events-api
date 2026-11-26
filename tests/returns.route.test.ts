import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { createApp } from "../src/app.js";
import { permissionResolutionService, type PermissionScope } from "../src/services/permission-resolution.service.js";
import { registrationService, type ReturnResultDto } from "../src/services/registration.service.js";
import { IDS, staffToken } from "./helpers/fixtures.js";
import { call, withServer } from "./helpers/http.js";

/** POST …/registrations/{id}/return (Phase 8 step 4): Guests › update in the path's organization; no body. */
const app = createApp();
const path = `/v1/organizations/${IDS.orgA}/events/${IDS.event}/registrations/${IDS.registration}/return`;

function allowPermissions(allowed: boolean) {
  return mock.method(permissionResolutionService, "resolvePermission", async (input: { scope: PermissionScope }) => ({
    allowed,
    source: allowed ? ("role_permission" as const) : ("default_deny" as const),
    scope: input.scope,
    roleIds: [],
  }));
}

afterEach(() => mock.restoreAll());

test("a return needs Guests › update in the path's organization; a view-only role is refused", async () => {
  const permission = allowPermissions(false);
  await withServer(app, async (baseUrl) => {
    assert.equal((await call(baseUrl, "POST", path, { token: staffToken() })).status, 403);
  });
  const asked = permission.mock.calls[0]?.arguments[0] as { moduleCode: string; action: string; scope: PermissionScope };
  assert.deepEqual([asked.moduleCode, asked.action, asked.scope.level], ["REGISTRATIONS", "update", "organization"]);
});

test("a return reaches the service with the path's ids and the staff member, and answers 200 with its outcome", async () => {
  allowPermissions(true);
  const result = { outcome: "RETURNED", registration: { id: IDS.registration }, refund_case: null } as unknown as ReturnResultDto;
  const returned = mock.method(registrationService, "returnRegistration", async () => result);
  await withServer(app, async (baseUrl) => {
    const response = await call(baseUrl, "POST", path, { token: staffToken() });
    assert.deepEqual([response.status, response.body.data.outcome], [200, "RETURNED"]);
  });
  assert.deepEqual(returned.mock.calls[0]?.arguments, [IDS.orgA, IDS.event, IDS.registration, IDS.user]);
});
