import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import jwt from "jsonwebtoken";
import { createApp } from "../src/app.js";
import { centralAuthClient } from "../src/clients/central-auth.client.js";
import { STAFF_CENTRAL_SESSION_COOKIE, STAFF_REFRESH_COOKIE } from "../src/config/app.js";
import { authConfig } from "../src/config/auth.js";
import { CentralAuthRateLimitedError, CentralAuthUnavailableError, InvalidCredentialsError } from "../src/errors/app-errors.js";
import { userRoleRepository } from "../src/repositories/user-role.repository.js";
import { authTokenService } from "../src/services/auth-token.service.js";
import { permissionResolutionService } from "../src/services/permission-resolution.service.js";
import { logger } from "../src/utils/logger.js";
import { DENIED_PERMISSION, FULL_PERMISSION } from "../src/utils/rbac.js";
import { assignment, IDS, staffToken } from "./helpers/fixtures.js";
import { call, withServer } from "./helpers/http.js";

/**
 * HTTP-level tests of staff login, refresh and logout. Central Auth is a test double
 * (mock.method on the client) and assignments come from a mocked repository: no network, no database.
 */
const app = createApp();
const REFRESH_TOKEN = "central-refresh-token-value";
const PROFILE = { mobile: "+251911000000", firstname: "Test", middlename: null, lastname: "User" };
const nowSeconds = () => Math.floor(Date.now() / 1000);

type HttpResult = { status: number; body: any; setCookie: string[] };

/** These endpoints are cookie-authenticated, so this sends a Cookie header (the shared call() helper does not). */
async function post(
  baseUrl: string,
  path: string,
  options: { cookies?: Record<string, string>; body?: unknown; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { ...options.headers };
  const cookieHeader = Object.entries(options.cookies ?? {})
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  if (cookieHeader) headers.Cookie = cookieHeader;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: options.body === undefined ? null : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, setCookie: response.headers.getSetCookie() };
}

function findSetCookie(setCookie: string[], name: string): string | undefined {
  return setCookie.find((header) => header.startsWith(`${name}=`));
}

function assertCookieCleared(setCookie: string[], name: string): void {
  const header = findSetCookie(setCookie, name);
  assert.ok(header, `${name} must be in Set-Cookie`);
  assert.ok(header.startsWith(`${name}=;`), `${name} must be cleared`);
  assert.match(header, /Expires=Thu, 01 Jan 1970/);
  assert.match(header, /Path=\/v1\/auth\/staff/);
  assert.match(header, /HttpOnly/);
}

/** Asserts the cookie is set (HttpOnly, staff path, Max-Age within bounds) and returns its value. */
function assertCookieSet(setCookie: string[], name: string, maxAge: { min: number; max: number }): string {
  const header = findSetCookie(setCookie, name);
  assert.ok(header && !header.startsWith(`${name}=;`), `${name} must be set`);
  assert.match(header, /Path=\/v1\/auth\/staff/);
  assert.match(header, /HttpOnly/);
  const seconds = Number(/Max-Age=(\d+)/.exec(header)?.[1]);
  assert.ok(seconds >= maxAge.min && seconds <= maxAge.max, `${name} Max-Age ${seconds} outside ${maxAge.min}..${maxAge.max}`);
  return decodeURIComponent(header.slice(name.length + 1).split(";")[0] ?? "");
}

/** A Central Auth-style access token (HS256, shared secret, iss auth_api), as auth-cheche would issue it. */
function centralAccessToken(): string {
  return jwt.sign({ user_id: IDS.user, token_type: "access", ...PROFILE }, authConfig.centralAuthJwtSecret, {
    algorithm: "HS256",
    expiresIn: 3 * 24 * 3600,
    issuer: authConfig.centralIssuer,
    subject: IDS.user,
  });
}

function confirmationFor(refreshToken: string): string {
  const signed = authTokenService.signStaffCentralSession({
    userId: IDS.user,
    profile: PROFILE,
    centralExpiresAt: nowSeconds() + 3 * 24 * 3600,
    refreshToken,
  });
  assert.ok(signed);
  return signed.token;
}

afterEach(() => mock.restoreAll());

// --- Login --------------------------------------------------------------------------------------

const CENTRAL_LOGIN_OK = async () => ({ accessToken: centralAccessToken(), refreshToken: REFRESH_TOKEN, refreshExpiresIn: null });

test("login sets the refresh cookie and a central-session confirmation bound to it", async () => {
  const login = mock.method(centralAuthClient, "passwordLogin", CENTRAL_LOGIN_OK);
  mock.method(userRoleRepository, "listActiveAssignmentsByUser", async () => [assignment()]);

  await withServer(app, async (baseUrl) => {
    const response = await post(baseUrl, "/v1/auth/staff/login", {
      body: { mobile: "0911000000", password: "secret", device_name: "Chrome on Mac", platform: "web" },
    });
    assert.deepEqual(
      login.mock.calls[0]?.arguments,
      [{ mobile: "+251911000000", password: "secret", device_name: "Chrome on Mac", platform: "web" }],
      "auth-cheche gets the normalised mobile and the device fields",
    );
    assert.equal(response.status, 200);
    assert.ok(response.body.data.accessToken);
    assert.equal(JSON.stringify(response.body).includes(REFRESH_TOKEN), false, "the refresh token never appears in JSON");

    assertCookieSet(response.setCookie, STAFF_REFRESH_COOKIE, { min: 1, max: authConfig.refreshCookie.maxAgeSeconds });
    const confirmation = assertCookieSet(response.setCookie, STAFF_CENTRAL_SESSION_COOKIE, {
      min: authConfig.centralSessionTtlSeconds - 60,
      max: authConfig.centralSessionTtlSeconds,
    });
    assert.ok(authTokenService.verifyStaffCentralSession(confirmation, REFRESH_TOKEN), "the confirmation is bound to the refresh token");
  });
});

test("login without an active staff assignment is refused with 403 and sets no cookie", async () => {
  mock.method(centralAuthClient, "passwordLogin", CENTRAL_LOGIN_OK);
  mock.method(userRoleRepository, "listActiveAssignmentsByUser", async () => []);

  await withServer(app, async (baseUrl) => {
    const response = await post(baseUrl, "/v1/auth/staff/login", { body: { mobile: "0911000000", password: "secret" } });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "staff_assignment_not_found");
    assert.deepEqual(response.setCookie, []);
  });
});

test("Central Auth refusals and outages map to stable error codes", async () => {
  const cases: Array<[string, Error, number, string]> = [
    ["wrong credentials", new InvalidCredentialsError("Invalid mobile number or password"), 401, "invalid_credentials"],
    ["rate limited or account locked", new CentralAuthRateLimitedError(), 429, "central_auth_rate_limited"],
    ["Central Auth down", new CentralAuthUnavailableError(), 503, "central_auth_unavailable"],
  ];

  for (const [label, error, status, code] of cases) {
    mock.method(centralAuthClient, "passwordLogin", async () => {
      throw error;
    });
    await withServer(app, async (baseUrl) => {
      const response = await post(baseUrl, "/v1/auth/staff/login", { body: { mobile: "0911000000", password: "secret" } });
      assert.equal(response.status, status, label);
      assert.equal(response.body.error.code, code, label);
    });
    mock.restoreAll();
  }
});

test("a legacy body with pin, or any unknown field, is rejected before auth-cheche is called", async () => {
  const login = mock.method(centralAuthClient, "passwordLogin", CENTRAL_LOGIN_OK);

  await withServer(app, async (baseUrl) => {
    for (const body of [
      { mobile: "0911000000", pin: "1234", password: "secret" },
      { mobile: "0911000000", password: "secret", remember_me: true },
    ]) {
      const response = await post(baseUrl, "/v1/auth/staff/login", { body });
      assert.equal(response.status, 400, JSON.stringify(Object.keys(body)));
      assert.equal(response.body.error.code, "validation_error");
    }
  });
  assert.equal(login.mock.callCount(), 0);
});

// --- Refresh ------------------------------------------------------------------------------------

test("refresh without a refresh cookie is 401 refresh_token_missing", async () => {
  await withServer(app, async (baseUrl) => {
    const response = await post(baseUrl, "/v1/auth/staff/refresh");
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, "refresh_token_missing");
  });
});

test("refresh from an untrusted site is refused before anything happens", async () => {
  const centralRefresh = mock.method(centralAuthClient, "refreshAccessToken", async () => {
    throw new Error("Central Auth must not be called");
  });

  await withServer(app, async (baseUrl) => {
    const response = await post(baseUrl, "/v1/auth/staff/refresh", {
      cookies: { [STAFF_REFRESH_COOKIE]: REFRESH_TOKEN },
      headers: { Origin: "http://evil.example" },
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "refresh_origin_not_allowed");
    assert.deepEqual(response.setCookie, []);
  });
  assert.equal(centralRefresh.mock.callCount(), 0);
});

test("refresh with a valid confirmation skips Central Auth, keeps both cookies, and re-reads assignments", async () => {
  const centralRefresh = mock.method(centralAuthClient, "refreshAccessToken", async () => {
    throw new Error("Central Auth must not be called");
  });
  const loadAssignments = mock.method(userRoleRepository, "listActiveAssignmentsByUser", async () => [assignment()]);

  await withServer(app, async (baseUrl) => {
    const response = await post(baseUrl, "/v1/auth/staff/refresh", {
      cookies: { [STAFF_REFRESH_COOKIE]: REFRESH_TOKEN, [STAFF_CENTRAL_SESSION_COOKIE]: confirmationFor(REFRESH_TOKEN) },
    });
    assert.equal(response.status, 200);
    assert.ok(response.body.data.accessToken);
    assert.deepEqual(response.setCookie, [], "neither cookie is touched");
  });
  assert.equal(centralRefresh.mock.callCount(), 0);
  assert.equal(loadAssignments.mock.callCount(), 1);
});

test("refresh without a usable confirmation asks Central Auth and sets a new confirmation", async () => {
  const expired = jwt.sign(
    { token_type: "staff_central_session", central_exp: nowSeconds() + 3_600, refresh_token_hash: "0".repeat(64), exp: nowSeconds() - 10 },
    authConfig.appTokenSecret,
    { algorithm: "HS256", issuer: authConfig.appIssuer, audience: authConfig.appAudience, subject: IDS.user },
  );
  const cases: Array<[string, Record<string, string>]> = [
    ["missing", {}],
    ["tampered", { [STAFF_CENTRAL_SESSION_COOKIE]: `${confirmationFor(REFRESH_TOKEN)}x` }],
    ["issued for another refresh token", { [STAFF_CENTRAL_SESSION_COOKIE]: confirmationFor("another-refresh-token") }],
    ["expired", { [STAFF_CENTRAL_SESSION_COOKIE]: expired }],
  ];

  for (const [label, confirmationCookie] of cases) {
    const centralRefresh = mock.method(centralAuthClient, "refreshAccessToken", async () => ({
      accessToken: centralAccessToken(),
      refreshToken: null, // not rotated: the existing refresh cookie stays
      refreshExpiresIn: null,
    }));
    mock.method(userRoleRepository, "listActiveAssignmentsByUser", async () => [assignment()]);

    await withServer(app, async (baseUrl) => {
      const response = await post(baseUrl, "/v1/auth/staff/refresh", {
        cookies: { [STAFF_REFRESH_COOKIE]: REFRESH_TOKEN, ...confirmationCookie },
      });
      assert.equal(response.status, 200, label);
      assert.equal(findSetCookie(response.setCookie, STAFF_REFRESH_COOKIE), undefined, `${label}: refresh cookie kept`);
      const confirmation = assertCookieSet(response.setCookie, STAFF_CENTRAL_SESSION_COOKIE, {
        min: authConfig.centralSessionTtlSeconds - 60,
        max: authConfig.centralSessionTtlSeconds,
      });
      assert.ok(authTokenService.verifyStaffCentralSession(confirmation, REFRESH_TOKEN), `${label}: new confirmation bound`);
    });
    assert.deepEqual(centralRefresh.mock.calls[0]?.arguments, [REFRESH_TOKEN], label);
    mock.restoreAll();
  }
});

test("a removed assignment ends the session even while the confirmation is valid", async () => {
  mock.method(userRoleRepository, "listActiveAssignmentsByUser", async () => []);

  await withServer(app, async (baseUrl) => {
    const response = await post(baseUrl, "/v1/auth/staff/refresh", {
      cookies: { [STAFF_REFRESH_COOKIE]: REFRESH_TOKEN, [STAFF_CENTRAL_SESSION_COOKIE]: confirmationFor(REFRESH_TOKEN) },
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "staff_assignment_not_found");
    assertCookieCleared(response.setCookie, STAFF_REFRESH_COOKIE);
    assertCookieCleared(response.setCookie, STAFF_CENTRAL_SESSION_COOKIE);
  });
});

// --- Logout -------------------------------------------------------------------------------------

test("logout revokes the Central Auth session with the cookie's refresh token and clears both cookies", async () => {
  const revoke = mock.method(centralAuthClient, "logout", async () => undefined);

  await withServer(app, async (baseUrl) => {
    const response = await post(baseUrl, "/v1/auth/staff/logout", {
      cookies: { [STAFF_REFRESH_COOKIE]: REFRESH_TOKEN, [STAFF_CENTRAL_SESSION_COOKIE]: confirmationFor(REFRESH_TOKEN) },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, { revoked: true });
    assertCookieCleared(response.setCookie, STAFF_REFRESH_COOKIE);
    assertCookieCleared(response.setCookie, STAFF_CENTRAL_SESSION_COOKIE);
  });
  assert.deepEqual(revoke.mock.calls[0]?.arguments, [REFRESH_TOKEN]);
});

test("a Central Auth failure never blocks logout, and the warning never contains the token", async () => {
  mock.method(centralAuthClient, "logout", async () => {
    throw new CentralAuthUnavailableError();
  });
  const warn = mock.method(logger, "warn");

  await withServer(app, async (baseUrl) => {
    const response = await post(baseUrl, "/v1/auth/staff/logout", { cookies: { [STAFF_REFRESH_COOKIE]: REFRESH_TOKEN } });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, { revoked: false });
    assertCookieCleared(response.setCookie, STAFF_REFRESH_COOKIE);
    assertCookieCleared(response.setCookie, STAFF_CENTRAL_SESSION_COOKIE);
  });
  assert.equal(warn.mock.callCount(), 1);
  assert.ok(!JSON.stringify(warn.mock.calls[0]?.arguments).includes(REFRESH_TOKEN), "token values are never logged");
});

test("logout without a refresh cookie still clears both cookies and does not call Central Auth", async () => {
  const revoke = mock.method(centralAuthClient, "logout", async () => undefined);

  await withServer(app, async (baseUrl) => {
    const response = await post(baseUrl, "/v1/auth/staff/logout");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, { revoked: false });
    assertCookieCleared(response.setCookie, STAFF_REFRESH_COOKIE);
    assertCookieCleared(response.setCookie, STAFF_CENTRAL_SESSION_COOKIE);
  });
  assert.equal(revoke.mock.callCount(), 0);
});

test("logout from an untrusted site is refused before anything happens", async () => {
  const revoke = mock.method(centralAuthClient, "logout", async () => undefined);

  await withServer(app, async (baseUrl) => {
    const response = await post(baseUrl, "/v1/auth/staff/logout", {
      cookies: { [STAFF_REFRESH_COOKIE]: REFRESH_TOKEN },
      headers: { Origin: "http://evil.example" },
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "refresh_origin_not_allowed");
    assert.deepEqual(response.setCookie, [], "the cookies are not touched");
  });
  assert.equal(revoke.mock.callCount(), 0, "Central Auth is not called");
});

test("logout from the trusted site goes through", async () => {
  mock.method(centralAuthClient, "logout", async () => undefined);

  await withServer(app, async (baseUrl) => {
    const response = await post(baseUrl, "/v1/auth/staff/logout", {
      cookies: { [STAFF_REFRESH_COOKIE]: REFRESH_TOKEN },
      headers: { Origin: "http://localhost:3000" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, { revoked: true });
  });
});

// --- Current session (/me) -----------------------------------------------------------------------

test("GET /staff/me returns user, assignment, permissions and navigation for a valid staff token", async () => {
  mock.method(userRoleRepository, "findActiveAssignmentByIdAndUser", async () => assignment());
  mock.method(userRoleRepository, "listActiveAssignmentsByUser", async () => [assignment()]);
  const permissions = { BRANCHES: { ...FULL_PERMISSION }, ROLES: { ...DENIED_PERMISSION } };
  mock.method(permissionResolutionService, "resolveStaffSession", async () => ({ permissions, navigation: [] }));

  await withServer(app, async (baseUrl) => {
    const response = await call(baseUrl, "GET", "/v1/auth/staff/me", { token: staffToken() });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.user.id, IDS.user);
    assert.equal(response.body.data.assignment.id, IDS.assignment);
    assert.deepEqual(response.body.data.permissions, permissions);
    assert.deepEqual(response.body.data.navigation, []);
  });
});

test("GET /staff/me refuses an expired staff token and a missing one", async () => {
  const expired = jwt.sign(
    {
      token_type: "staff_access",
      assignment_id: IDS.assignment,
      role_id: IDS.roleA,
      organization_id: IDS.orgA,
      branch_id: null,
      exp: nowSeconds() - 10,
      ...PROFILE,
    },
    authConfig.appTokenSecret,
    { algorithm: "HS256", issuer: authConfig.appIssuer, audience: authConfig.appAudience, subject: IDS.user },
  );

  await withServer(app, async (baseUrl) => {
    const expiredResponse = await call(baseUrl, "GET", "/v1/auth/staff/me", { token: expired });
    assert.equal(expiredResponse.status, 401);
    assert.equal(expiredResponse.body.error.code, "expired_token");

    const missingResponse = await call(baseUrl, "GET", "/v1/auth/staff/me");
    assert.equal(missingResponse.status, 401);
    assert.equal(missingResponse.body.error.code, "authentication_required");
  });
});
