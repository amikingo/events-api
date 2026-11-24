import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { centralAuthClient } from "../src/clients/central-auth.client.js";
import { authConfig } from "../src/config/auth.js";
import {
  AppError,
  CentralAuthRateLimitedError,
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
/** auth-cheche's sign-in reply: not wrapped in a data envelope. */
const SIGNIN_REPLY = {
  message: "Signin successful",
  access_token: "access-abc",
  refresh_token: "refresh-abc",
  service_ids: [authConfig.centralAuthServiceId],
  service_id: authConfig.centralAuthServiceId,
  session_id: "sess-123456",
};

test("password login posts to /v1/users/signin/password with our service_id and no Authorization header", async () => {
  const calls = fakeFetch(200, JSON.stringify(SIGNIN_REPLY));

  const tokens = await centralAuthClient.passwordLogin(LOGIN);

  assert.deepEqual(tokens, { accessToken: "access-abc", refreshToken: "refresh-abc", refreshExpiresIn: null });
  const [{ url, init } = { url: "", init: undefined }] = calls;
  assert.equal(url, `${authConfig.centralAuthUrl}/v1/users/signin/password?service_id=${authConfig.centralAuthServiceId}`);
  assert.equal(init?.method, "POST");
  const body = init?.body;
  assert.ok(typeof body === "string", "the request body is a JSON string");
  assert.deepEqual(JSON.parse(body), LOGIN);
  const headerNames = Object.keys((init?.headers ?? {}) as Record<string, string>).map((name) => name.toLowerCase());
  assert.ok(!headerNames.includes("authorization"));
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
      assert.equal(error.message, "Invalid mobile number or password", `${status} uses the fixed message`);
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
