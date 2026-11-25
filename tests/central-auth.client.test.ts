import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import jwt from "jsonwebtoken";
import { centralAuthClient } from "../src/clients/central-auth.client.js";
import { authConfig } from "../src/config/auth.js";
import {
  AppError,
  CentralAuthRateLimitedError,
  CentralAuthUnavailableError,
  ConflictError,
  InvalidCredentialsError,
  MalformedCentralAuthResponseError,
} from "../src/errors/app-errors.js";

/** The Central Auth client against a fake fetch: no network, no Central Auth needed. */
type FetchCall = { url: string; init: RequestInit | undefined };

function fakeFetch(status: number, body: string | null): FetchCall[] {
  const calls: FetchCall[] = [];
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return new Response(body, { status, headers: { "Content-Type": "application/json" } });
  });
  return calls;
}

afterEach(() => mock.restoreAll());

test("logout posts the refresh token to /v1/auth/logout without an Authorization header", async () => {
  const calls = fakeFetch(200, JSON.stringify({ message: "Logged out" }));

  await centralAuthClient.logout("refresh-abc");

  assert.equal(calls.length, 1);
  const [{ url, init } = { url: "", init: undefined }] = calls;
  assert.equal(url, `${authConfig.centralAuthUrl}/v1/auth/logout`);
  assert.equal(init?.method, "POST");
  const body = init?.body;
  assert.ok(typeof body === "string", "the request body is a JSON string");
  assert.deepEqual(JSON.parse(body), { refresh_token: "refresh-abc" });
  const headerNames = Object.keys((init?.headers ?? {}) as Record<string, string>).map((name) => name.toLowerCase());
  assert.ok(!headerNames.includes("authorization"), "staff hold no Central access token, so none is sent");
});

test("an empty 204 reply from logout counts as success", async () => {
  fakeFetch(204, null);
  await assert.doesNotReject(centralAuthClient.logout("refresh-abc"));
});

test("a rejected logout throws, so the caller reports revoked: false", async () => {
  fakeFetch(401, JSON.stringify({ error: "Invalid refresh token" }));
  await assert.rejects(centralAuthClient.logout("refresh-abc"), AppError);
});

// --- Password sign-in -----------------------------------------------------------------------------

const LOGIN = { mobile: "+251911000000", password: "secret-password", device_name: "Chrome on Mac", platform: "web" as const };
const EMAIL_LOGIN = { email: "staff@example.et", password: "secret-password", platform: "web" as const };
const REFUSED_MESSAGE = "Invalid mobile number, email or password";
/** auth-cheche's sign-in reply: not wrapped in a data envelope. */
const SIGNIN_REPLY = {
  message: "Signin successful",
  access_token: "access-abc",
  refresh_token: "refresh-abc",
  service_ids: [authConfig.centralAuthServiceId],
  service_id: authConfig.centralAuthServiceId,
  session_id: "sess-123456",
};

test("password login posts to /v1/users/signin/password without a service_id and without an Authorization header", async () => {
  const calls = fakeFetch(200, JSON.stringify(SIGNIN_REPLY));

  const tokens = await centralAuthClient.passwordLogin(LOGIN);

  assert.deepEqual(tokens, { accessToken: "access-abc", refreshToken: "refresh-abc", refreshExpiresIn: null });
  const [{ url, init } = { url: "", init: undefined }] = calls;
  assert.equal(url, `${authConfig.centralAuthUrl}/v1/users/signin/password`, "no ?service_id=: access is decided by user_role");
  assert.equal(init?.method, "POST");
  const body = init?.body;
  assert.ok(typeof body === "string", "the request body is a JSON string");
  assert.deepEqual(JSON.parse(body), LOGIN);
  const headerNames = Object.keys((init?.headers ?? {}) as Record<string, string>).map((name) => name.toLowerCase());
  assert.ok(!headerNames.includes("authorization"));
});

test("email login posts to /v1/users/signin/email without a service_id and without an Authorization header", async () => {
  const calls = fakeFetch(200, JSON.stringify(SIGNIN_REPLY));

  const tokens = await centralAuthClient.emailLogin(EMAIL_LOGIN);

  assert.deepEqual(tokens, { accessToken: "access-abc", refreshToken: "refresh-abc", refreshExpiresIn: null });
  const [{ url, init } = { url: "", init: undefined }] = calls;
  assert.equal(url, `${authConfig.centralAuthUrl}/v1/users/signin/email`);
  const body = init?.body;
  assert.ok(typeof body === "string", "the request body is a JSON string");
  assert.deepEqual(JSON.parse(body), EMAIL_LOGIN);
  const headerNames = Object.keys((init?.headers ?? {}) as Record<string, string>).map((name) => name.toLowerCase());
  assert.ok(!headerNames.includes("authorization"));
});

test("a refused email login gets the same fixed message as a mobile login", async () => {
  fakeFetch(404, JSON.stringify({ error: "user not found" }));
  await assert.rejects(
    centralAuthClient.emailLogin(EMAIL_LOGIN),
    (error: unknown) => error instanceof InvalidCredentialsError && error.message === REFUSED_MESSAGE,
  );
});

test("a sign-in reply without a refresh token is refused", async () => {
  fakeFetch(200, JSON.stringify({ message: "Signin successful", access_token: "access-abc" }));
  await assert.rejects(centralAuthClient.passwordLogin(LOGIN), MalformedCentralAuthResponseError);
});

test("every refused login gets the same message; auth-cheche's reason stays in the cause for the log", async () => {
  const refusals = [
    [400, "mobile is required"],
    [401, "invalid password"],
    [403, "user not registered for service"],
    [404, "user not found"],
  ] as const;

  for (const [status, reason] of refusals) {
    fakeFetch(status, JSON.stringify({ error: reason }));
    await assert.rejects(centralAuthClient.passwordLogin(LOGIN), (error: unknown) => {
      assert.ok(error instanceof InvalidCredentialsError, `${status} becomes invalid_credentials`);
      assert.equal(error.message, REFUSED_MESSAGE, `${status} uses the fixed message`);
      assert.ok(error.cause instanceof Error, `${status} keeps a cause`);
      assert.equal(error.cause.message, `Central Auth ${status}: ${reason}`);
      return true;
    });
    mock.restoreAll();
  }
});

test("auth-cheche's 429 (rate limit or locked account) becomes central_auth_rate_limited on login and refresh", async () => {
  fakeFetch(429, JSON.stringify({ message: "Too many requests" }));
  await assert.rejects(centralAuthClient.passwordLogin(LOGIN), CentralAuthRateLimitedError);
  await assert.rejects(centralAuthClient.refreshAccessToken("refresh-abc"), CentralAuthRateLimitedError);
});

test("auth-cheche's error text is read from error, response or message", async () => {
  for (const field of ["error", "response", "message"]) {
    fakeFetch(409, JSON.stringify({ [field]: `already exists (${field})` }));
    await assert.rejects(
      centralAuthClient.logout("refresh-abc"),
      (error: unknown) => error instanceof ConflictError && error.message === `already exists (${field})`,
    );
    mock.restoreAll();
  }
});

// --- Staff lookups with the service token (Phase 2b) ----------------------------------------------

const PERSON = { id: "7d4b1f0e-2c3a-4e5f-8a9b-0c1d2e3f4a5b", mobile: "+251911234567", firstname: "Hana", middlename: null, lastname: "Bekele" };

function bearerOf(init: RequestInit | undefined): string {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return headers.Authorization ?? "";
}

test("a lookup by mobile sends a 5-minute service token of the system user, signed with the shared secret", async () => {
  const calls = fakeFetch(200, JSON.stringify({ user: PERSON }));

  const user = await centralAuthClient.findUserByMobile("+251911234567");

  assert.deepEqual(user, { userId: PERSON.id, mobile: "+251911234567", firstname: "Hana", middlename: null, lastname: "Bekele" });
  const [{ url, init } = { url: "", init: undefined }] = calls;
  assert.equal(url, `${authConfig.centralAuthUrl}/v1/users/get-user-by-mobile?mobile=%2B251911234567`);
  const token = bearerOf(init).replace(/^Bearer /, "");
  const claims = jwt.verify(token, authConfig.centralAuthJwtSecret, { algorithms: ["HS256"], issuer: authConfig.centralIssuer }) as jwt.JwtPayload;
  assert.deepEqual(
    [claims.token_type, claims.auth_role, claims.user_id, claims.service_ids],
    ["access", "super_admin", "00000000-0000-0000-0000-000000000000", [authConfig.centralAuthServiceId]],
  );
  assert.equal((claims.exp ?? 0) - (claims.iat ?? 0), 300, "valid for 5 minutes");
});

test("a lookup accepts the reply shapes auth-cheche uses and reads localized names; 404 means no account", async () => {
  for (const body of [{ data: { user: PERSON } }, PERSON, { user: { ...PERSON, id: undefined, user_id: PERSON.id, firstname: { en: "Hana", am: "ሃና" } } }]) {
    fakeFetch(200, JSON.stringify(body));
    const user = await centralAuthClient.findUserByMobile("+251911234567");
    assert.deepEqual([user?.userId, user?.firstname], [PERSON.id, "Hana"], JSON.stringify(body));
    mock.restoreAll();
  }

  fakeFetch(404, JSON.stringify({ error: "user not found" }));
  assert.equal(await centralAuthClient.findUserByMobile("+251911000000"), null);
  mock.restoreAll();

  fakeFetch(200, JSON.stringify({ user: { mobile: "+251911234567" } }));
  await assert.rejects(centralAuthClient.findUserByMobile("+251911234567"), MalformedCentralAuthResponseError, "no user id");
});

test("names for several people come from one specific_users call; a refused service token is a 503, never the staff member's fault", async () => {
  const calls = fakeFetch(200, JSON.stringify({ users: [PERSON] }));
  const users = await centralAuthClient.getUsersByIds([PERSON.id]);
  assert.deepEqual(users.map((user) => user.lastname), ["Bekele"]);
  const [{ url, init } = { url: "", init: undefined }] = calls;
  assert.equal(url, `${authConfig.centralAuthUrl}/v1/users/specific_users`);
  assert.ok(typeof init?.body === "string");
  assert.deepEqual(JSON.parse(init.body), { user_ids: [PERSON.id] });
  assert.match(bearerOf(init), /^Bearer /);
  mock.restoreAll();

  assert.deepEqual(await centralAuthClient.getUsersByIds([]), [], "no call for an empty list");

  for (const status of [401, 403]) {
    fakeFetch(status, JSON.stringify({ error: "invalid token" }));
    await assert.rejects(centralAuthClient.findUserByMobile("+251911234567"), (error: unknown) => error instanceof CentralAuthUnavailableError);
    mock.restoreAll();
  }
});
