import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { createApp } from "../src/app.js";
import { centralAuthClient } from "../src/clients/central-auth.client.js";
import { STAFF_REFRESH_COOKIE } from "../src/config/app.js";
import { userRoleRepository } from "../src/repositories/user-role.repository.js";
import { assignment, centralAccessToken } from "./helpers/fixtures.js";
import { call, withServer } from "./helpers/http.js";

/**
 * Staff login with email + password, at the HTTP level. Central Auth and assignments are test doubles.
 * Its own file on purpose: each test file runs in its own process, so it has its own login rate-limit
 * budget (10 per minute), separate from auth.route.test.ts.
 */
const app = createApp();
const CENTRAL_LOGIN_OK = async () => ({
  accessToken: centralAccessToken(),
  refreshToken: "central-refresh-token-value",
  refreshExpiresIn: null,
});

afterEach(() => mock.restoreAll());

test("email login signs in at auth-cheche by email and sets the refresh cookie", async () => {
  const emailLogin = mock.method(centralAuthClient, "emailLogin", CENTRAL_LOGIN_OK);
  const passwordLogin = mock.method(centralAuthClient, "passwordLogin", CENTRAL_LOGIN_OK);
  mock.method(userRoleRepository, "listActiveAssignmentsByUser", async () => [assignment()]);

  await withServer(app, async (baseUrl) => {
    const response = await call(baseUrl, "POST", "/v1/auth/staff/login", {
      body: { email: "staff@example.et", password: "secret", platform: "web" },
    });
    assert.equal(response.status, 200);
    assert.ok(response.body.data.accessToken);
    const refreshCookie = response.headers.getSetCookie().find((header) => header.startsWith(`${STAFF_REFRESH_COOKIE}=`));
    assert.ok(refreshCookie && !refreshCookie.startsWith(`${STAFF_REFRESH_COOKIE}=;`), "the refresh cookie is set");
  });
  assert.deepEqual(emailLogin.mock.calls[0]?.arguments, [{ email: "staff@example.et", password: "secret", platform: "web" }]);
  assert.equal(passwordLogin.mock.callCount(), 0, "mobile sign-in is not used");
});

test("login needs exactly one of mobile or email, and a valid email; auth-cheche is not called otherwise", async () => {
  const emailLogin = mock.method(centralAuthClient, "emailLogin", CENTRAL_LOGIN_OK);
  const passwordLogin = mock.method(centralAuthClient, "passwordLogin", CENTRAL_LOGIN_OK);

  await withServer(app, async (baseUrl) => {
    const cases: Array<[string, Record<string, string>]> = [
      ["both mobile and email", { mobile: "0911000000", email: "staff@example.et", password: "secret" }],
      ["neither mobile nor email", { password: "secret" }],
      ["not an email address", { email: "not-an-email", password: "secret" }],
    ];
    for (const [label, body] of cases) {
      const response = await call(baseUrl, "POST", "/v1/auth/staff/login", { body });
      assert.equal(response.status, 400, label);
      assert.equal(response.body.error.code, "validation_error", label);
    }
  });
  assert.equal(emailLogin.mock.callCount() + passwordLogin.mock.callCount(), 0);
});
