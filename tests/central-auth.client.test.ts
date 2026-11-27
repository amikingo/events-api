import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import jwt from "jsonwebtoken";
import { centralAuthClient } from "../src/clients/central-auth.client.js";
import { authConfig } from "../src/config/auth.js";
import {
  AppError,
  CentralAuthRateLimitedError,
  CentralAuthRefusedError,
  CentralAuthUnavailableError,
  ConflictError,
  InvalidCodeError,
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

// --- Guest accounts (Phase 6): sign-up and SMS codes -----------------------------------------------------

test("guest sign-up, code confirmation, sending a code and code sign-in post the documented bodies, with no service_id and no Authorization", async () => {
  const calls = fakeFetch(200, JSON.stringify({ message: "ok", access_token: "a", refresh_token: "r" }));
  await centralAuthClient.signUpWithPassword({ mobile: "+251911223344", password: "pass-1234", firstname: "Hana", lastname: "Bekele" });
  await centralAuthClient.verifyCode({ mobile: "+251911223344", otp: "123456" });
  await centralAuthClient.sendCode("+251911223344");
  await centralAuthClient.signInWithCode({ mobile: "+251911223344", otp: "654321" });

  assert.deepEqual(
    calls.map((entry) => entry.url),
    ["/v1/users/signup/password", "/v1/users/verify-otp", "/v1/users/send-otp", "/v1/auth/otp-login"].map((path) => `${authConfig.centralAuthUrl}${path}`),
  );
  assert.deepEqual(
    calls.map((entry) => JSON.parse(entry.init?.body as string)),
    [
      { mobile: "+251911223344", password: "pass-1234", firstname: "Hana", lastname: "Bekele" },
      { mobile: "+251911223344", otp: "123456" },
      { mobile: "+251911223344" },
      { mobile: "+251911223344", otp: "654321" },
    ],
  );
  for (const entry of calls) {
    assert.ok(!entry.url.includes("service_id"));
    const headerNames = Object.keys((entry.init?.headers ?? {}) as Record<string, string>).map((name) => name.toLowerCase());
    assert.ok(!headerNames.includes("authorization"));
  }
});

test("code sign-in reads tokens leniently: top level, inside data, tokens, token or session, snake_case or camelCase", async () => {
  const shapes = [
    { access_token: "a1", refresh_token: "r1" },
    { data: { access_token: "a2", refresh_token: "r2", refresh_expires_in: 600 } },
    { data: { tokens: { accessToken: "a3", refreshToken: "r3" } } },
    { token: { access_token: "a4", refresh_token: "r4" } },
    { session: { accessToken: "a5", refreshToken: "r5", refreshExpiresIn: 60 } },
  ];
  const expected = [
    { accessToken: "a1", refreshToken: "r1", refreshExpiresIn: null },
    { accessToken: "a2", refreshToken: "r2", refreshExpiresIn: 600 },
    { accessToken: "a3", refreshToken: "r3", refreshExpiresIn: null },
    { accessToken: "a4", refreshToken: "r4", refreshExpiresIn: null },
    { accessToken: "a5", refreshToken: "r5", refreshExpiresIn: 60 },
  ];
  for (const [index, shape] of shapes.entries()) {
    fakeFetch(200, JSON.stringify(shape));
    assert.deepEqual(await centralAuthClient.signInWithCode({ mobile: "+251911223344", otp: "1" }), expected[index]);
    mock.restoreAll();
  }
});

test("an unexpected code sign-in reply is a clear 502, never a crash; no refresh token is refused too", async () => {
  for (const body of [{ message: "OTP login successful" }, { data: { user: { id: "x" } } }, { access_token: "only-access" }]) {
    fakeFetch(200, JSON.stringify(body));
    await assert.rejects(centralAuthClient.signInWithCode({ mobile: "+251911223344", otp: "1" }), MalformedCentralAuthResponseError, JSON.stringify(body));
    mock.restoreAll();
  }
});

test("guest refusals keep auth-cheche's text and status: 409 exists, 404 no account, 400 wrong code, 429 too many", async () => {
  fakeFetch(409, JSON.stringify({ error: "User already exists" }));
  await assert.rejects(centralAuthClient.signUpWithPassword({ mobile: "+251911223344", password: "p", firstname: "H", lastname: "B" }), ConflictError);
  mock.restoreAll();

  fakeFetch(404, JSON.stringify({ error: "User not found" }));
  await assert.rejects(centralAuthClient.sendCode("+251911223344"), (error: unknown) => error instanceof AppError && error.statusCode === 404);
  mock.restoreAll();

  fakeFetch(400, JSON.stringify({ response: "Invalid or expired OTP" }));
  await assert.rejects(centralAuthClient.verifyCode({ mobile: "+251911223344", otp: "0" }), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.deepEqual([error.statusCode, error.message], [400, "Invalid or expired OTP"]);
    return true;
  });
  mock.restoreAll();

  fakeFetch(429, JSON.stringify({ message: "Too many requests" }));
  await assert.rejects(centralAuthClient.sendCode("+251911223344"), CentralAuthRateLimitedError);
});

// --- Staff accounts (Phase 2e): creating an account and editing names ----------------------------------------

test("creating a staff account posts to create-verified with our service_id and the service token; 409 means it exists", async () => {
  const calls = fakeFetch(201, JSON.stringify({ data: { user: { id: "7d4b1f0e-2c3a-4e5f-8a9b-0c1d2e3f4a5b", mobile: "+251911223344", firstname: "Hana" } } }));
  const user = await centralAuthClient.createVerifiedUser({ mobile: "+251911223344", firstname: "Hana", lastname: "Bekele", password: "secret-123" });
  assert.equal(user?.userId, "7d4b1f0e-2c3a-4e5f-8a9b-0c1d2e3f4a5b");
  const [{ url, init } = { url: "", init: undefined }] = calls;
  assert.equal(url, `${authConfig.centralAuthUrl}/v1/users/create-verified?service_id=${encodeURIComponent(authConfig.centralAuthServiceId)}`);
  assert.deepEqual(JSON.parse(init?.body as string), { mobile: "+251911223344", firstname: "Hana", lastname: "Bekele", password: "secret-123" });
  const authorization = (init?.headers as Record<string, string>).Authorization ?? "";
  assert.match(authorization, /^Bearer /, "the service token");
  mock.restoreAll();

  fakeFetch(201, JSON.stringify({ message: "created" }));
  assert.equal(await centralAuthClient.createVerifiedUser({ mobile: "+251911223344", firstname: "H", lastname: "B", password: "secret-123" }), null, "no account in the reply");
  mock.restoreAll();

  fakeFetch(409, JSON.stringify({ error: "User already exists" }));
  await assert.rejects(centralAuthClient.createVerifiedUser({ mobile: "+251911223344", firstname: "H", lastname: "B", password: "secret-123" }), ConflictError);
});

test("editing names is a PUT with names only; a refused service token is 409 central_auth_refused", async () => {
  const calls = fakeFetch(200, JSON.stringify({ message: "updated" }));
  await centralAuthClient.updateUserNames("7d4b1f0e-2c3a-4e5f-8a9b-0c1d2e3f4a5b", { firstname: "Hanna", lastname: undefined });
  const [{ url, init } = { url: "", init: undefined }] = calls;
  assert.equal(url, `${authConfig.centralAuthUrl}/v1/users/7d4b1f0e-2c3a-4e5f-8a9b-0c1d2e3f4a5b`);
  assert.equal(init?.method, "PUT");
  assert.deepEqual(JSON.parse(init?.body as string), { firstname: "Hanna" }, "only the names that changed");
  mock.restoreAll();

  fakeFetch(403, JSON.stringify({ error: "owner verification required" }));
  await assert.rejects(centralAuthClient.updateUserNames("7d4b1f0e-2c3a-4e5f-8a9b-0c1d2e3f4a5b", { firstname: "X" }), CentralAuthRefusedError);
});

// --- Profiles and passwords (Phase 10) -------------------------------------------------------------------------

const USER_ID = "7d4b1f0e-2c3a-4e5f-8a9b-0c1d2e3f4a5b";

test("a profile is read from specific_users with the service token, including email, sex and date of birth", async () => {
  const calls = fakeFetch(200, JSON.stringify({ data: { users: [{ id: USER_ID, mobile: "+251911223344", firstname: "Hana", lastname: "Bekele", email: "hana@example.et", sex: "FEMALE", date_of_birth: "1995-03-04" }] } }));
  const profile = await centralAuthClient.getUserProfile(USER_ID);
  assert.equal(calls[0]?.url, `${authConfig.centralAuthUrl}/v1/users/specific_users`);
  assert.match((calls[0]?.init?.headers as Record<string, string>).Authorization ?? "", /^Bearer /);
  assert.deepEqual(
    { email: profile?.email, sex: profile?.sex, date_of_birth: profile?.date_of_birth, firstname: profile?.firstname },
    { email: "hana@example.et", sex: "FEMALE", date_of_birth: "1995-03-04", firstname: "Hana" },
  );
  mock.restoreAll();

  fakeFetch(200, JSON.stringify({ data: { users: [] } }));
  assert.equal(await centralAuthClient.getUserProfile(USER_ID), null);
});

test("a profile edit is one PUT with the fields sent (null clears to \"\"); nothing to send makes no call", async () => {
  const calls = fakeFetch(200, JSON.stringify({ message: "updated" }));
  await centralAuthClient.updateUserProfile(USER_ID, { email: null, sex: "MALE", date_of_birth: undefined });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, `${authConfig.centralAuthUrl}/v1/users/${USER_ID}`);
  assert.equal(calls[0]?.init?.method, "PUT");
  assert.deepEqual(JSON.parse(calls[0]?.init?.body as string), { email: "", sex: "MALE" });

  await centralAuthClient.updateUserProfile(USER_ID, {});
  assert.equal(calls.length, 1);
});

test("changing a password is a PUT with the person's own Central token, not the service token", async () => {
  const calls = fakeFetch(200, JSON.stringify({ message: "Password updated" }));
  await centralAuthClient.updatePassword(USER_ID, "central-access", "old-secret", "new-secret-1");
  assert.equal(calls[0]?.url, `${authConfig.centralAuthUrl}/v1/users/password/update/${USER_ID}`);
  assert.equal(calls[0]?.init?.method, "PUT");
  assert.equal((calls[0]?.init?.headers as Record<string, string>).Authorization, "Bearer central-access");
  assert.deepEqual(JSON.parse(calls[0]?.init?.body as string), { old_password: "old-secret", new_password: "new-secret-1" });
});

test("a reset posts mobile, otp and new_password; a refused code (400, 401 or 404) is invalid_code; 5xx stays 503", async () => {
  const calls = fakeFetch(200, JSON.stringify({ message: "Password reset" }));
  await centralAuthClient.resetPassword({ mobile: "+251911223344", otp: "123456", newPassword: "new-secret-1" });
  assert.equal(calls[0]?.url, `${authConfig.centralAuthUrl}/v1/users/reset-password`);
  assert.deepEqual(JSON.parse(calls[0]?.init?.body as string), { mobile: "+251911223344", otp: "123456", new_password: "new-secret-1" });

  for (const status of [400, 401, 404]) {
    mock.restoreAll();
    fakeFetch(status, JSON.stringify({ error: "Invalid OTP" }));
    await assert.rejects(centralAuthClient.resetPassword({ mobile: "+251911223344", otp: "000000", newPassword: "new-secret-1" }), InvalidCodeError);
  }
  mock.restoreAll();
  fakeFetch(502, JSON.stringify({ error: "down" }));
  await assert.rejects(centralAuthClient.resetPassword({ mobile: "+251911223344", otp: "000000", newPassword: "new-secret-1" }), CentralAuthUnavailableError);
});
