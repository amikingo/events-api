import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { createApp } from "../src/app.js";
import { paymentCaseService } from "../src/services/payment-case.service.js";
import { permissionResolutionService, type PermissionScope } from "../src/services/permission-resolution.service.js";
import { IDS, staffToken } from "./helpers/fixtures.js";
import { call, withServer } from "./helpers/http.js";

/** /v1/organizations/{id}/payment-cases (Phase 8 step 3): the Payments module, and what each resolution needs. */
const app = createApp();
const base = `/v1/organizations/${IDS.orgA}/payment-cases`;
const CASE_ID = "e1000000-0000-4000-8000-000000000001";

function allowPermissions(allowed: boolean) {
  return mock.method(permissionResolutionService, "resolvePermission", async (input: { scope: PermissionScope }) => ({
    allowed,
    source: allowed ? ("role_permission" as const) : ("default_deny" as const),
    scope: input.scope,
    roleIds: [],
  }));
}

afterEach(() => mock.restoreAll());

test("payment cases use the Payments module: view to list and read, update to resolve, in the path's organization", async () => {
  const permission = allowPermissions(false);
  await withServer(app, async (baseUrl) => {
    const token = staffToken();
    assert.equal((await call(baseUrl, "GET", base, { token })).status, 403);
    assert.equal((await call(baseUrl, "GET", `${base}/${CASE_ID}`, { token })).status, 403);
    assert.equal((await call(baseUrl, "POST", `${base}/${CASE_ID}/resolve`, { token, body: { resolution: "CLOSED_WITHOUT_REFUND", note: "x" } })).status, 403);
  });
  assert.deepEqual(
    permission.mock.calls.map((entry) => {
      const input = entry.arguments[0] as { moduleCode: string; action: string; scope: PermissionScope };
      return [input.moduleCode, input.action, input.scope.level];
    }),
    [
      ["PAYMENTS", "view", "organization"],
      ["PAYMENTS", "view", "organization"],
      ["PAYMENTS", "update", "organization"],
    ],
  );
});

test("a refund needs its amount, currency and merchant reference; a closure needs a note; the list takes its filters", async () => {
  allowPermissions(true);
  const resolve = mock.method(paymentCaseService, "resolve", async () => ({}) as never);
  const list = mock.method(paymentCaseService, "list", async () => ({ rows: [], count: 0 }));
  await withServer(app, async (baseUrl) => {
    const token = staffToken();
    const path = `${base}/${CASE_ID}/resolve`;
    const missing = await call(baseUrl, "POST", path, { token, body: { resolution: "REFUNDED" } });
    assert.deepEqual(
      [missing.status, missing.body.error.details.issues.map((issue: { path: string }) => issue.path).sort()],
      [400, ["body.merchant_reference", "body.refunded_amount", "body.refunded_currency"]],
    );
    assert.equal((await call(baseUrl, "POST", path, { token, body: { resolution: "REFUNDED", refunded_amount: "0", refunded_currency: "ETB", merchant_reference: "R" } })).status, 400, "above zero");
    assert.equal((await call(baseUrl, "POST", path, { token, body: { resolution: "CLOSED_WITHOUT_REFUND" } })).status, 400);
    assert.equal((await call(baseUrl, "POST", path, { token, body: { resolution: "REFUNDED", refunded_amount: "1000", refunded_currency: "etb", merchant_reference: " CP-9 " } })).status, 200);
    assert.equal((await call(baseUrl, "GET", `${base}?status=OPEN&kind=TICKET_RETURN&event_id=${IDS.event}`, { token })).status, 200);
    assert.equal((await call(baseUrl, "GET", `${base}?kind=SOMETHING`, { token })).status, 400);
  });
  assert.deepEqual(resolve.mock.calls[0]?.arguments.slice(0, 4), [IDS.orgA, CASE_ID, { resolution: "REFUNDED", refunded_amount: "1000.00", refunded_currency: "ETB", merchant_reference: "CP-9" }, IDS.user]);
  const [, query] = list.mock.calls[0]?.arguments ?? [];
  assert.deepEqual([query?.status, query?.kind, query?.event_id], ["OPEN", "TICKET_RETURN", IDS.event]);
});
