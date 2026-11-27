import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { createApp } from "../src/app.js";
import { staffAccountService } from "../src/services/staff-account.service.js";
import { centralAccessToken, IDS, staffToken } from "./helpers/fixtures.js";
import { call, withServer } from "./helpers/http.js";

/**
 * A staff member's own account over HTTP (Phase 10): real auth, validation and envelope; the service is stubbed.
 * The password routes share the login limiter (10 a minute per address), so this file stays well under it.
 */
const app = createApp();
const SAME_REPLY = { sent: true as const, message: "If this mobile has staff access, a code has been sent to it." };

afterEach(() => mock.restoreAll());

test("own names need a staff token (a guest's Central token is refused) and take names only", async () => {
  const update = mock.method(staffAccountService, "updateOwnNames", async () => ({
    profile: { firstname: "Hanna", middlename: null, lastname: "Bekele", mobile: "+251911000000", email: null },
    changed: true,
    access_token: "new-staff-token",
    expires_in: 600,
  }));
  await withServer(app, async (baseUrl) => {
    assert.equal((await call(baseUrl, "PUT", "/v1/auth/staff/profile", { body: { firstname: "Hanna", lastname: "Bekele" } })).status, 401);
    assert.equal((await call(baseUrl, "PUT", "/v1/auth/staff/profile", { token: centralAccessToken(), body: { firstname: "Hanna", lastname: "Bekele" } })).status, 401);
    const token = staffToken();
    for (const body of [{ firstname: "Hanna" }, { firstname: "Hanna", lastname: "Bekele", email: "h@x.et" }, { firstname: "Hanna", lastname: "Bekele", mobile: "0911223344" }]) {
      assert.equal((await call(baseUrl, "PUT", "/v1/auth/staff/profile", { token, body })).status, 400, JSON.stringify(body));
    }
    const ok = await call(baseUrl, "PUT", "/v1/auth/staff/profile", { token, body: { firstname: "Hanna", lastname: "Bekele" } });
    assert.deepEqual([ok.status, ok.body.data.access_token, ok.body.message], [200, "new-staff-token", "Your names were updated"]);
  });
  assert.equal(update.mock.callCount(), 1);
  assert.equal((update.mock.calls[0]?.arguments as unknown[] | undefined)?.length, 2);
  assert.equal(((update.mock.calls[0]?.arguments as unknown[])[0] as { assignmentId: string }).assignmentId, IDS.assignment, "acts on the signed-in staff member");
});

test("change password needs a staff token; a short new password or the same one is 400 before the service", async () => {
  const change = mock.method(staffAccountService, "changePassword", async () => ({ updated: true as const }));
  await withServer(app, async (baseUrl) => {
    assert.equal((await call(baseUrl, "PUT", "/v1/auth/staff/password", { body: { old_password: "old-secret", new_password: "new-secret-1" } })).status, 401);
    const token = staffToken();
    assert.equal((await call(baseUrl, "PUT", "/v1/auth/staff/password", { token, body: { old_password: "old-secret", new_password: "short" } })).status, 400);
    assert.equal((await call(baseUrl, "PUT", "/v1/auth/staff/password", { token, body: { old_password: "same-secret", new_password: "same-secret" } })).status, 400);
    const ok = await call(baseUrl, "PUT", "/v1/auth/staff/password", { token, body: { old_password: "old-secret", new_password: "new-secret-1" } });
    assert.deepEqual([ok.status, ok.body.data], [200, { updated: true }]);
    assert.ok(!JSON.stringify(ok.body).includes("new-secret-1"), "passwords are never echoed");
  });
  assert.equal(change.mock.callCount(), 1);
});

test("forgot and reset password are public; forgot always answers the same; reset needs the code and a long enough password", async () => {
  const forgot = mock.method(staffAccountService, "requestPasswordReset", async () => SAME_REPLY);
  const reset = mock.method(staffAccountService, "resetPassword", async () => ({ reset: true as const }));
  await withServer(app, async (baseUrl) => {
    const sent = await call(baseUrl, "POST", "/v1/auth/staff/forgot-password", { body: { mobile: "0911223344" } });
    assert.deepEqual([sent.status, sent.body.data], [200, SAME_REPLY]);
    assert.equal((await call(baseUrl, "POST", "/v1/auth/staff/reset-password", { body: { mobile: "0911223344", otp: "123456", new_password: "short" } })).status, 400);
    const done = await call(baseUrl, "POST", "/v1/auth/staff/reset-password", { body: { mobile: "0911223344", otp: "123456", new_password: "new-secret-1" } });
    assert.deepEqual([done.status, done.body.data], [200, { reset: true }]);
  });
  assert.equal(forgot.mock.callCount(), 1);
  assert.equal(reset.mock.callCount(), 1);
});
