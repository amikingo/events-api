import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { createApp } from "../src/app.js";
import { checkInService, type CheckInDto } from "../src/services/check-in.service.js";
import { permissionResolutionService, type PermissionScope } from "../src/services/permission-resolution.service.js";
import { IDS, staffToken } from "./helpers/fixtures.js";
import { withServer, type TestResponse } from "./helpers/http.js";

/** POST …/events/{eventId}/check-ins (Phase 8 step 2): Guests › update, a required Idempotency-Key, a clean code. */
const app = createApp();
const path = `/v1/organizations/${IDS.orgA}/events/${IDS.event}/check-ins`;
const RESULT: CheckInDto = {
  result: "ADMITTED",
  checked_in_at: new Date("2026-11-27T10:00:00Z"),
  checked_in_by: IDS.user,
  ticket: { id: IDS.registration, code: "K7M2Q9XP", ticket_type: { code: "GA", name: "General Admission" }, holder: null, order: { reference: "ABCDE23456" } },
};

function allowPermissions(allowed: boolean) {
  return mock.method(permissionResolutionService, "resolvePermission", async (input: { scope: PermissionScope }) => ({
    allowed,
    source: allowed ? ("role_permission" as const) : ("default_deny" as const),
    scope: input.scope,
    roleIds: [],
  }));
}

async function scan(baseUrl: string, body: unknown, key: string | null = "gate-1-scan-0001"): Promise<TestResponse> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${staffToken()}` };
  if (key !== null) headers["Idempotency-Key"] = key;
  const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}

afterEach(() => mock.restoreAll());

test("check-in needs Guests › update in the path's organization; a view-only role is refused", async () => {
  const permission = allowPermissions(false);
  await withServer(app, async (baseUrl) => {
    assert.equal((await scan(baseUrl, { code: "K7M2Q9XP" })).status, 403);
  });
  const asked = permission.mock.calls[0]?.arguments[0] as { moduleCode: string; action: string; scope: PermissionScope };
  assert.deepEqual([asked.moduleCode, asked.action, asked.scope.level, (asked.scope as { organizationId?: string }).organizationId], ["REGISTRATIONS", "update", "organization", IDS.orgA]);
});

test("a typed code may be lower case with spaces; a malformed code or a missing key is 400; the reply is the service's result", async () => {
  allowPermissions(true);
  const admit = mock.method(checkInService, "admit", async () => RESULT);
  await withServer(app, async (baseUrl) => {
    const ok = await scan(baseUrl, { code: " k7m2 q9xp " });
    assert.deepEqual([ok.status, ok.body.data.result, ok.body.data.ticket.code], [200, "ADMITTED", "K7M2Q9XP"]);
    assert.equal((await scan(baseUrl, { code: "K7M2Q9X0" })).status, 400, "0 isn't in the code alphabet");
    assert.equal((await scan(baseUrl, { code: "K7M2Q9XP", extra: 1 })).status, 400);
    const noKey = await scan(baseUrl, { code: "K7M2Q9XP" }, null);
    assert.deepEqual([noKey.status, noKey.body.error.details.issues[0].path], [400, "headers.idempotency-key"]);
  });
  assert.equal(admit.mock.callCount(), 1);
  assert.deepEqual(admit.mock.calls[0]?.arguments[0], { organizationId: IDS.orgA, eventId: IDS.event, code: "K7M2Q9XP", idempotencyKey: "gate-1-scan-0001", actorId: IDS.user });
});
