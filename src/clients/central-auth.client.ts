import jwt from "jsonwebtoken";
import { z } from "zod";
import { authConfig } from "../config/auth.js";
import {
  CentralAuthRateLimitedError,
  CentralAuthUnavailableError,
  ConflictError,
  InvalidCredentialsError,
  MalformedCentralAuthResponseError,
  NotFoundError,
  ValidationAppError,
} from "../errors/app-errors.js";
import { requestJson, UpstreamRequestError } from "./http.js";

const UPSTREAM = "central_auth";

/**
 * Login and refresh refusals always get this text, whatever Central said, so the screen never learns
 * whether the account exists, is unverified or is not registered for this service. The real reason
 * goes to the server log through the error's cause.
 */
const CREDENTIALS_REFUSED_MESSAGE = "Invalid mobile number, email or password";
const CREDENTIALS_REFUSED_STATUSES = [400, 401, 403, 404];

type SignInDevice = {
  device_id?: string | undefined;
  device_name?: string | undefined;
  platform?: "ios" | "android" | "web" | undefined;
};
export type PasswordLoginInput = { mobile: string; password: string } & SignInDevice;
export type EmailLoginInput = { email: string; password: string } & SignInDevice;

export type CentralTokens = {
  accessToken: string;
  refreshToken: string | null;
  refreshExpiresIn: number | null;
};

// Upstream payloads are untrusted input: parse them, never cast them.
const TokenPayload = z.looseObject({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  refresh_expires_in: z.number().int().positive().optional(),
});

function unwrapEnvelope(body: unknown): unknown {
  if (body && typeof body === "object" && "data" in body && body.data && typeof body.data === "object") {
    return body.data;
  }
  return body;
}

/** auth-cheche puts its text in `error` (standard), `response` (OTP endpoints) or `message` (429). */
function upstreamMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    for (const field of ["error", "response", "message"]) {
      const value = record[field];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return fallback;
}

/**
 * A 5-minute service token for auth-cheche's user lookups, built the way bookings_api builds its own: an access
 * token of the system user, signed with the shared APP_AUTH_TOKEN (see docs/authentication.md "Known risk"). Made
 * only here, for one request at a time; never logged, never returned.
 */
const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";
const SERVICE_TOKEN_TTL_SECONDS = 300;

function serviceToken(): string {
  return jwt.sign(
    {
      user_id: SYSTEM_USER_ID,
      firstname: "Service",
      lastname: "EventsAPI",
      mobile: "+251900000000",
      service_ids: [authConfig.centralAuthServiceId],
      token_type: "access",
      auth_role: "super_admin",
    },
    authConfig.centralAuthJwtSecret,
    { algorithm: "HS256", expiresIn: SERVICE_TOKEN_TTL_SECONDS, issuer: authConfig.centralIssuer, subject: SYSTEM_USER_ID },
  );
}

async function call(path: string, init: { method: "GET" | "POST"; body?: unknown; credentialsFlow?: boolean; asService?: boolean }) {
  try {
    const response = await requestJson(new URL(`${authConfig.centralAuthUrl}${path}`), {
      upstream: UPSTREAM,
      timeoutMs: authConfig.centralAuthTimeoutMs,
      method: init.method,
      body: init.body,
      ...(init.asService ? { headers: { Authorization: `Bearer ${serviceToken()}` } } : {}),
    });

    if (!response.ok) {
      const message = upstreamMessage(response.body, "Central Auth rejected the request");
      // For the server log only (the error handler logs the cause); never sent to the client.
      const cause = new Error(`Central Auth ${response.status}: ${message}`);
      // auth-cheche answers 429 both for its per-IP rate limit and for an account locked after failed attempts.
      if (response.status === 429) throw new CentralAuthRateLimitedError(undefined, undefined, { cause });
      // A refused service token is our configuration (APP_AUTH_TOKEN or service id), never the staff member's fault.
      if (init.asService && (response.status === 401 || response.status === 403)) {
        throw new CentralAuthUnavailableError("Central Auth refused this API's service token", undefined, { cause });
      }
      if (init.credentialsFlow && CREDENTIALS_REFUSED_STATUSES.includes(response.status)) {
        throw new InvalidCredentialsError(CREDENTIALS_REFUSED_MESSAGE, undefined, { cause });
      }
      if (response.status === 400) throw new ValidationAppError(message, undefined, { cause });
      if (response.status === 401 || response.status === 403) throw new InvalidCredentialsError(message, undefined, { cause });
      if (response.status === 404) throw new NotFoundError(message, undefined, { cause });
      if (response.status === 409) throw new ConflictError(message, undefined, { cause });
      if (response.status >= 500) throw new CentralAuthUnavailableError(undefined, undefined, { cause });
      throw new MalformedCentralAuthResponseError(undefined, undefined, { cause });
    }
    return unwrapEnvelope(response.body);
  } catch (error) {
    if (error instanceof UpstreamRequestError) {
      throw error.kind === "non_json"
        ? new MalformedCentralAuthResponseError("Central Auth returned a non-JSON payload", undefined, { cause: error })
        : new CentralAuthUnavailableError(`Central Auth request failed (${error.kind})`, undefined, { cause: error });
    }
    throw error;
  }
}

function parseTokens(payload: unknown, { requireRefresh }: { requireRefresh: boolean }): CentralTokens {
  const parsed = TokenPayload.safeParse(payload);
  if (!parsed.success) throw new MalformedCentralAuthResponseError("Central Auth token payload is invalid");
  if (requireRefresh && !parsed.data.refresh_token) {
    // A login without a refresh token would create a session that silently cannot renew.
    throw new MalformedCentralAuthResponseError("Central Auth login response is missing a refresh token");
  }
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token ?? null,
    refreshExpiresIn: parsed.data.refresh_expires_in ?? null,
  };
}

/**
 * Shared by both sign-in calls. No service_id is sent, like bookings_api (decided 25 November 2026): with it,
 * auth-cheche refuses accounts not registered for that service ("403 User is not registered for this service"),
 * and existing Cheche accounts usually aren't. Access is decided by this API's own user_role rows instead.
 * Refusals get the fixed message; a refresh token is required. No Authorization header is sent.
 */
async function signIn(path: string, body: PasswordLoginInput | EmailLoginInput): Promise<CentralTokens> {
  const payload = await call(path, { method: "POST", body, credentialsFlow: true });
  return parseTokens(payload, { requireRefresh: true });
}

/** auth-cheche mobile + password sign-in. */
async function passwordLogin(input: PasswordLoginInput): Promise<CentralTokens> {
  return signIn("/v1/users/signin/password", input);
}

/** auth-cheche email + password sign-in. Works only for accounts that have an email in auth-cheche. */
async function emailLogin(input: EmailLoginInput): Promise<CentralTokens> {
  return signIn("/v1/users/signin/email", input);
}

async function refreshAccessToken(refreshToken: string): Promise<CentralTokens> {
  const payload = await call("/v1/auth/refresh", {
    method: "POST",
    body: { refresh_token: refreshToken },
    credentialsFlow: true,
  });
  return parseTokens(payload, { requireRefresh: false });
}

/**
 * Ends the Central Auth session behind a refresh token. Staff hold only this API's own access
 * token, never a Central one, so no Authorization header is sent: the refresh token is revoked
 * on its own. Resolves on any 2xx; failures throw the usual mapped errors.
 */
async function logout(refreshToken: string): Promise<void> {
  await call("/v1/auth/logout", { method: "POST", body: { refresh_token: refreshToken } });
}

// --- User lookups for staff management (Phase 2b), with the service token ------------------------

/** An auth-cheche person: who the staff screens show. Names may come as text or as a {en, am, …} label. */
export type CentralUser = {
  userId: string;
  mobile: string | null;
  firstname: string | null;
  middlename: string | null;
  lastname: string | null;
};

const CentralUserPayload = z.looseObject({
  id: z.string().optional(),
  user_id: z.string().optional(),
  mobile: z.string().nullish(),
  firstname: z.unknown().optional(),
  first_name: z.unknown().optional(),
  middlename: z.unknown().optional(),
  middle_name: z.unknown().optional(),
  lastname: z.unknown().optional(),
  last_name: z.unknown().optional(),
});

/** "Hana", or { en: "Hana", am: "ሃና" } → "Hana" (English first, then any text). */
function nameText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const text = [record.en, ...Object.values(record)].find((item): item is string => typeof item === "string" && item.trim() !== "");
      if (text) return text.trim();
    }
  }
  return null;
}

function toCentralUser(candidate: unknown): CentralUser {
  const parsed = CentralUserPayload.safeParse(candidate);
  const userId = z.uuid().safeParse(parsed.success ? (parsed.data.user_id ?? parsed.data.id) : undefined);
  if (!parsed.success || !userId.success) throw new MalformedCentralAuthResponseError("Central Auth user record is invalid");
  const data = parsed.data;
  return {
    userId: userId.data,
    mobile: data.mobile ?? null,
    firstname: nameText(data.firstname, data.first_name),
    middlename: nameText(data.middlename, data.middle_name),
    lastname: nameText(data.lastname, data.last_name),
  };
}

function field(payload: unknown, name: string): unknown {
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>)[name] : undefined;
}

/** The account using this (already normalized) mobile number, or null when there is none. */
async function findUserByMobile(mobile: string): Promise<CentralUser | null> {
  const query = new URLSearchParams({ mobile });
  let payload: unknown;
  try {
    payload = await call(`/v1/users/get-user-by-mobile?${query.toString()}`, { method: "GET", asService: true });
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
  const candidate = field(payload, "user") ?? payload;
  return candidate === null || candidate === undefined ? null : toCentralUser(candidate);
}

/** Several accounts at once (names for the staff list). Unknown ids are simply absent. */
async function getUsersByIds(userIds: readonly string[]): Promise<CentralUser[]> {
  if (userIds.length === 0) return [];
  const payload = await call("/v1/users/specific_users", { method: "POST", body: { user_ids: [...userIds] }, asService: true });
  const list = field(payload, "users") ?? payload;
  if (!Array.isArray(list)) throw new MalformedCentralAuthResponseError("Central Auth user list is invalid");
  return list.map(toCentralUser);
}

export const centralAuthClient = { passwordLogin, emailLogin, refreshAccessToken, logout, findUserByMobile, getUsersByIds };
