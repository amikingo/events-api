import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import jwt from "jsonwebtoken";
import { createApp } from "../src/app.js";
import { centralAuthClient, type CentralUser } from "../src/clients/central-auth.client.js";
import { CUSTOMER_REFRESH_COOKIE } from "../src/config/app.js";
import { authConfig } from "../src/config/auth.js";
import { ConflictError, InvalidCredentialsError, NotFoundError, ValidationAppError } from "../src/errors/app-errors.js";
import { authRefreshLimiter, customerAuthLimiter, customerCodePerMobileLimiter } from "../src/middleware/rate-limit.js";
import { customerAuthService } from "../src/services/customer-auth.service.js";
import { registrationService } from "../src/services/registration.service.js";
import { centralAccessToken, IDS, staffToken } from "./helpers/fixtures.js";
import { call, withServer } from "./helpers/http.js";

/**
 * Guest accounts (Phase 6) over HTTP: real validation, cookies, rate limits and token checks; auth-cheche is a test
 * double (mock.method on the client). No network, no database.
 */
const app = createApp();
const GUEST_ID = "d1111111-1111-4111-8111-111111111111";
const MOBILE = "+251911223344";
const REFRESH = "guest-refresh-token";

/** An auth-cheche access token for the guest; `mobile: null` models a token without a mobile. */
function guestToken(mobile: string | null = MOBILE): string {
  return jwt.sign({ user_id: GUEST_ID, token_type: "access", mobile, firstname: "Hana", lastname: "Bekele" }, authConfig.centralAuthJwtSecret, {
    algorithm: "HS256",
    expiresIn: 3 * 24 * 3600,
    issuer: authConfig.centralIssuer,
    subject: GUEST_ID,
  });
}

const tokens = (mobile: string | null = MOBILE) => ({ accessToken: guestToken(mobile), refreshToken: REFRESH, refreshExpiresIn: 7 * 24 * 3600 });

type HttpResult = { status: number; body: any; setCookie: string[] };

async function post(path: string, options: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {}): Promise<HttpResult> {
  return withServer(app, async (baseUrl) => {
    const headers: Record<string, string> = { ...options.headers };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.cookie) headers.Cookie = `${CUSTOMER_REFRESH_COOKIE}=${options.cookie}`;
    const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers, body: options.body === undefined ? null : JSON.stringify(options.body) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, setCookie: response.headers.getSetCookie() };
  });
}

const refreshCookieOf = (setCookie: string[]) => setCookie.find((header) => header.startsWith(`${CUSTOMER_REFRESH_COOKIE}=`));

beforeEach(() => {
  customerAuthLimiter.resetKey("127.0.0.1");
  authRefreshLimiter.resetKey("127.0.0.1");
  customerCodePerMobileLimiter.resetKey(`mobile:${MOBILE}`);
});
afterEach(() => mock.restoreAll());

test("sign-up sends the names, mobile (as +251…) and password to auth-cheche and answers 201; an existing account is 409 account_exists", async () => {
  const signUp = mock.method(centralAuthClient, "signUpWithPassword", async (_input: unknown) => undefined);

  const created = await post("/v1/auth/customer/signup", { body: { first_name: "Hana", last_name: "Bekele", mobile: "0911 223 344", password: "pass-1234" } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(signUp.mock.calls[0]?.arguments[0], { mobile: MOBILE, password: "pass-1234", firstname: "Hana", lastname: "Bekele" });
  assert.equal(refreshCookieOf(created.setCookie), undefined, "no session before the code is confirmed");

  signUp.mock.mockImplementation(async () => {
    throw new ConflictError("User already exists");
  });
  const exists = await post("/v1/auth/customer/signup", { body: { first_name: "Hana", last_name: "Bekele", mobile: MOBILE, password: "pass-1234" } });
  assert.deepEqual([exists.status, exists.body.error.code, exists.body.error.message], [409, "account_exists", "You already have a Cheche account. Sign in"]);

  const strict = await post("/v1/auth/customer/signup", { body: { first_name: "Hana", last_name: "Bekele", mobile: MOBILE, password: "x", email: "h@x.et" } });
  assert.equal(strict.status, 400, "auth-cheche takes no email, so none is accepted");
});

test("confirming checks the code, then signs in with the password: the session comes back and the refresh token only in the HttpOnly cookie", async () => {
  const order: string[] = [];
  mock.method(centralAuthClient, "verifyCode", async (_input: unknown) => void order.push("verify"));
  const login = mock.method(centralAuthClient, "passwordLogin", async (_input: unknown) => {
    order.push("login");
    return tokens();
  });

  const confirmed = await post("/v1/auth/customer/signup/confirm", { body: { mobile: MOBILE, otp: "123456", password: "pass-1234" } });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.deepEqual(order, ["verify", "login"]);
  assert.deepEqual(login.mock.calls[0]?.arguments[0], { mobile: MOBILE, password: "pass-1234" });
  const session = confirmed.body.data;
  assert.deepEqual([session.tokenType, session.user.id, session.user.mobile, session.user.firstname], ["Bearer", GUEST_ID, MOBILE, "Hana"]);
  assert.ok(session.expiresIn > 0);
  assert.equal(JSON.stringify(confirmed.body).includes(REFRESH), false, "the refresh token never reaches JavaScript");
  const cookie = refreshCookieOf(confirmed.setCookie);
  assert.ok(cookie, "refresh cookie set");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Path=\/v1\/auth\/customer/);
});

test("a wrong or expired code is 400 invalid_code with auth-cheche's text, and nothing signs in", async () => {
  mock.method(centralAuthClient, "verifyCode", async () => {
    throw new ValidationAppError("Invalid or expired OTP");
  });
  const login = mock.method(centralAuthClient, "passwordLogin", async () => tokens());
  const refused = await post("/v1/auth/customer/signup/confirm", { body: { mobile: MOBILE, otp: "000000", password: "pass-1234" } });
  assert.deepEqual([refused.status, refused.body.error.code, refused.body.error.message], [400, "invalid_code", "Invalid or expired OTP"]);
  assert.equal(login.mock.callCount(), 0);

  mock.method(centralAuthClient, "signInWithCode", async () => {
    throw new InvalidCredentialsError("OTP expired");
  });
  const byCode = await post("/v1/auth/customer/login/code", { body: { mobile: MOBILE, otp: "000000" } });
  assert.deepEqual([byCode.status, byCode.body.error.code], [400, "invalid_code"]);
});

test("sign-in by code: the mobile comes from auth-cheche by user id when the token has none", async () => {
  mock.method(centralAuthClient, "signInWithCode", async (_input: unknown) => tokens(null));
  const lookup = mock.method(centralAuthClient, "getUsersByIds", async (_ids: readonly string[]): Promise<CentralUser[]> => [
    { userId: GUEST_ID, mobile: "0911223344", firstname: "Hana", middlename: null, lastname: "Bekele" },
  ]);

  const signedIn = await post("/v1/auth/customer/login/code", { body: { mobile: MOBILE, otp: "123456" } });
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  assert.equal(signedIn.body.data.user.mobile, MOBILE, "normalized to +251…");
  assert.deepEqual(lookup.mock.calls[0]?.arguments[0], [GUEST_ID]);
});

test("sending a code: no account is 404 account_not_found; the same number gets 3 codes every 10 minutes, whatever its spelling", async () => {
  const send = mock.method(centralAuthClient, "sendCode", async (_mobile: string) => undefined);
  for (const spelling of ["0911223344", "+251911223344", "251911223344"]) {
    const sent = await post("/v1/auth/customer/code", { body: { mobile: spelling } });
    assert.equal(sent.status, 200, spelling);
  }
  const fourth = await post("/v1/auth/customer/signup/resend", { body: { mobile: "0911 223 344" } });
  assert.deepEqual([fourth.status, fourth.body.error.code], [429, "rate_limited"], "resend shares the per-mobile limit");
  assert.equal(send.mock.callCount(), 3);
  assert.deepEqual(send.mock.calls.map((entry) => entry.arguments[0]), [MOBILE, MOBILE, MOBILE]);

  customerCodePerMobileLimiter.resetKey(`mobile:${MOBILE}`);
  send.mock.mockImplementation(async () => {
    throw new NotFoundError("User not found");
  });
  const unknown = await post("/v1/auth/customer/code", { body: { mobile: MOBILE } });
  assert.deepEqual([unknown.status, unknown.body.error.code], [404, "account_not_found"]);
});

test("a refused resend shows auth-cheche's own text", async () => {
  mock.method(centralAuthClient, "sendCode", async () => {
    throw new ValidationAppError("Account is not verified yet");
  });
  const refused = await post("/v1/auth/customer/signup/resend", { body: { mobile: MOBILE } });
  assert.deepEqual([refused.status, refused.body.error.message], [400, "Account is not verified yet"]);
});

test("refresh needs the cookie and rotates it; a refused one clears it; logout revokes and clears", async () => {
  const missing = await post("/v1/auth/customer/refresh");
  assert.deepEqual([missing.status, missing.body.error.code], [401, "refresh_token_missing"]);

  const refresh = mock.method(centralAuthClient, "refreshAccessToken", async (_token: string) => ({ ...tokens(), refreshToken: "rotated" }));
  const renewed = await post("/v1/auth/customer/refresh", { cookie: REFRESH });
  assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
  assert.equal(refresh.mock.calls[0]?.arguments[0], REFRESH);
  assert.match(refreshCookieOf(renewed.setCookie) ?? "", new RegExp(`^${CUSTOMER_REFRESH_COOKIE}=rotated;`));

  refresh.mock.mockImplementation(async () => {
    throw new InvalidCredentialsError();
  });
  const refused = await post("/v1/auth/customer/refresh", { cookie: REFRESH });
  assert.deepEqual([refused.status, refused.body.error.code], [401, "refresh_token_invalid"]);
  assert.match(refreshCookieOf(refused.setCookie) ?? "", /Expires=Thu, 01 Jan 1970/);

  const logout = mock.method(centralAuthClient, "logout", async (_token: string) => undefined);
  const out = await post("/v1/auth/customer/logout", { cookie: REFRESH });
  assert.deepEqual([out.status, out.body.data.revoked], [200, true]);
  assert.equal(logout.mock.calls[0]?.arguments[0], REFRESH);
  assert.match(refreshCookieOf(out.setCookie) ?? "", /Expires=Thu, 01 Jan 1970/);

  const evil = await post("/v1/auth/customer/refresh", { cookie: REFRESH, headers: { Origin: "http://evil.example" } });
  assert.equal(evil.body.error.code, "refresh_origin_not_allowed");
});

test("guest and staff tokens never cross: a guest token can't reach staff routes, a staff token can't reach guest routes", async () => {
  const tickets = mock.method(registrationService, "listMyTickets", async (_userId: string) => []);
  await withServer(app, async (baseUrl) => {
    const guest = guestToken();
    assert.equal((await call(baseUrl, "GET", "/v1/auth/staff/me", { token: guest })).status, 401);
    assert.equal((await call(baseUrl, "GET", `/v1/organizations/${IDS.orgA}/roles`, { token: guest })).status, 401);
    assert.equal((await call(baseUrl, "GET", "/v1/customer/registrations", { token: staffToken() })).status, 401);
    assert.equal((await call(baseUrl, "GET", "/v1/auth/customer/me", { token: staffToken() })).status, 401);
    assert.equal((await call(baseUrl, "GET", "/v1/customer/registrations")).status, 401, "no token");

    const mine = await call(baseUrl, "GET", "/v1/customer/registrations", { token: guest });
    assert.deepEqual([mine.status, mine.body.data], [200, []]);
    const me = await call(baseUrl, "GET", "/v1/auth/customer/me", { token: guest });
    assert.deepEqual([me.status, me.body.data.id, me.body.data.mobile], [200, GUEST_ID, MOBILE]);
  });
  assert.deepEqual(tickets.mock.calls[0]?.arguments, [GUEST_ID], "who is asking comes only from the token");
  assert.ok(centralAccessToken(), "fixtures still sign Central tokens");
});

test("a guest edits their own names with their own token; a staff token can't, and only names are taken", async () => {
  const update = mock.method(customerAuthService, "updateOwnNames", async () => ({ id: GUEST_ID, mobile: MOBILE, firstname: "Hanna", middlename: null, lastname: "Bekele" }));
  await withServer(app, async (baseUrl) => {
    assert.equal((await call(baseUrl, "PUT", "/v1/auth/customer/profile", { token: staffToken(), body: { firstname: "Hanna", lastname: "Bekele" } })).status, 401);
    assert.equal((await call(baseUrl, "PUT", "/v1/auth/customer/profile", { token: guestToken(), body: { firstname: "Hanna", lastname: "Bekele", mobile: "0911000000" } })).status, 400);
    const ok = await call(baseUrl, "PUT", "/v1/auth/customer/profile", { token: guestToken(), body: { firstname: "Hanna", lastname: "Bekele" } });
    assert.deepEqual([ok.status, ok.body.data.firstname], [200, "Hanna"]);
  });
  assert.equal(update.mock.callCount(), 1);
});
