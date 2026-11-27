import jwt from "jsonwebtoken";
import { z } from "zod";
import { authConfig } from "../config/auth.js";
import {
  CentralAuthRateLimitedError,
  CentralAuthUnavailableError,
  CentralAuthRefusedError,
  ConflictError,
  InvalidCodeError,
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

async function call(
  path: string,
  init: {
    method: "GET" | "POST" | "PUT";
    body?: unknown;
    credentialsFlow?: boolean;
    asService?: boolean;
    /** Phase 10: act as the user, with their own Central access token (e.g. changing their password). */
    userToken?: string;
    /** A refused service token is 409 central_auth_refused (an edit auth-cheche said no to), not 503. */
    serviceRefusalIsConflict?: boolean;
  },
) {
  try {
    const response = await requestJson(new URL(`${authConfig.centralAuthUrl}${path}`), {
      upstream: UPSTREAM,
      timeoutMs: authConfig.centralAuthTimeoutMs,
      method: init.method,
      body: init.body,
      ...(init.asService ? { headers: { Authorization: `Bearer ${serviceToken()}` } } : init.userToken ? { headers: { Authorization: `Bearer ${init.userToken}` } } : {}),
    });

    if (!response.ok) {
      const message = upstreamMessage(response.body, "Central Auth rejected the request");
      // For the server log only (the error handler logs the cause); never sent to the client.
      const cause = new Error(`Central Auth ${response.status}: ${message}`);
      // auth-cheche answers 429 both for its per-IP rate limit and for an account locked after failed attempts.
      if (response.status === 429) throw new CentralAuthRateLimitedError(undefined, undefined, { cause });
      // A refused service token is our configuration (APP_AUTH_TOKEN or service id), never the staff member's fault.
      if (init.asService && (response.status === 401 || response.status === 403)) {
        if (init.serviceRefusalIsConflict) throw new CentralAuthRefusedError(undefined, undefined, { cause });
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

// --- Guest accounts (Phase 6): sign-up and SMS codes, no service token, no service_id -----------------------
//
// auth-cheche's swagger documents these requests but not their reply bodies, so replies are read leniently:
// tokens may sit at the top level or under tokens / token / session (after the usual data envelope), in
// snake_case or camelCase. Refusals keep auth-cheche's own text (error, then response, then message), so the
// guest auth service can show it; it maps the status to this API's own codes.

const TOKEN_CONTAINERS = ["tokens", "token", "session"] as const;

/** Reads tokens from the shapes auth-cheche might use; a reply with no access token is a clear 502, never a crash. */
function parseGuestTokens(payload: unknown): CentralTokens {
  const candidates = [payload, ...TOKEN_CONTAINERS.map((name) => field(payload, name))];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Record<string, unknown>;
    const normalized = {
      access_token: record.access_token ?? record.accessToken,
      refresh_token: record.refresh_token ?? record.refreshToken,
      refresh_expires_in: record.refresh_expires_in ?? record.refreshExpiresIn,
    };
    if (typeof normalized.access_token !== "string" || !normalized.access_token) continue;
    return parseTokens(
      Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined && value !== null)),
      { requireRefresh: true },
    );
  }
  throw new MalformedCentralAuthResponseError("Central Auth sign-in reply has no access token");
}

export type GuestSignUpInput = { mobile: string; password: string; firstname: string; lastname: string };

/** Creates an UNVERIFIED Cheche account; auth-cheche sends a code by SMS. 409 when the account exists. */
async function signUpWithPassword(input: GuestSignUpInput): Promise<void> {
  await call("/v1/users/signup/password", { method: "POST", body: input });
}

/** Confirms a new account with the SMS code (UNVERIFIED becomes VERIFIED). 400 for a wrong or expired code. */
async function verifyCode(input: { mobile: string; otp: string }): Promise<void> {
  await call("/v1/users/verify-otp", { method: "POST", body: input });
}

/** Sends a code by SMS to an existing account. 404 when there is none; 429 when too many were sent. */
async function sendCode(mobile: string): Promise<void> {
  await call("/v1/users/send-otp", { method: "POST", body: { mobile } });
}

/** Signs in with an SMS code instead of a password. A refresh token is required, as for password sign-in. */
async function signInWithCode(input: { mobile: string; otp: string }): Promise<CentralTokens> {
  return parseGuestTokens(await call("/v1/auth/otp-login", { method: "POST", body: input }));
}

// --- Staff accounts (Phase 2e): creating an account and editing names, with the service token -------------------
//
// docs/authentication.md "Creating staff accounts" and "Editing a staff member's details". Replies are read leniently
// (the account may come back at the top level or under `user`, as `id` or `user_id`); when the reply has no usable
// account, the caller looks the mobile up again.

export type NewStaffAccount = { mobile: string; firstname: string; middlename?: string | null; lastname: string; password: string };

/**
 * Creates a verified Cheche account (no SMS code) registered to this service. 409 (ConflictError) means the account
 * already exists. Returns the account when the reply names it, otherwise null. The password is sent once and never
 * kept.
 */
async function createVerifiedUser(input: NewStaffAccount): Promise<CentralUser | null> {
  const query = new URLSearchParams({ service_id: authConfig.centralAuthServiceId });
  const payload = await call(`/v1/users/create-verified?${query.toString()}`, {
    method: "POST",
    asService: true,
    body: {
      mobile: input.mobile,
      firstname: input.firstname,
      ...(input.middlename ? { middlename: input.middlename } : {}),
      lastname: input.lastname,
      password: input.password,
    },
  });
  const candidate = field(payload, "user") ?? payload;
  try {
    return candidate && typeof candidate === "object" ? toCentralUser(candidate) : null;
  } catch {
    return null;
  }
}

export type StaffNames = { firstname?: string | undefined; middlename?: string | null | undefined; lastname?: string | undefined };

/** Phase 10: what staff may edit in a person's Cheche profile. Never mobile, status, PIN or password. */
export type ProfilePatch = StaffNames & { email?: string | null | undefined; sex?: string | null | undefined; date_of_birth?: string | null | undefined };

/** Phase 10: a person's editable profile as auth-cheche holds it ("" or null means not set). */
export type CentralProfile = {
  userId: string;
  mobile: string | null;
  firstname: string | null;
  middlename: string | null;
  lastname: string | null;
  email: string | null;
  sex: string | null;
  date_of_birth: string | null;
};

const optionalText = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

/** One person's full editable profile (POST /v1/users/specific_users with the service token); null when unknown. */
async function getUserProfile(userId: string): Promise<CentralProfile | null> {
  const payload = await call("/v1/users/specific_users", { method: "POST", body: { user_ids: [userId] }, asService: true });
  const list = field(payload, "users") ?? payload;
  if (!Array.isArray(list)) throw new MalformedCentralAuthResponseError("Central Auth user list is invalid");
  const raw = list.find((item) => {
    const record = item as Record<string, unknown> | null;
    return record !== null && typeof record === "object" && (record.id === userId || record.user_id === userId);
  }) as Record<string, unknown> | undefined;
  if (!raw) return null;
  const user = toCentralUser(raw);
  return {
    ...user,
    email: optionalText(raw.email),
    sex: optionalText(raw.sex),
    date_of_birth: optionalText(raw.date_of_birth ?? raw.dateOfBirth),
  };
}

/**
 * Phase 10: changes a person's profile fields in auth-cheche (PUT /v1/users/{id} with the service token): names, email,
 * sex, date of birth, only those sent ("" clears an optional field). A refusal of the service token is 409
 * central_auth_refused, never a 401.
 */
async function updateUserProfile(userId: string, patch: ProfilePatch): Promise<void> {
  const body = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined).map(([key, value]) => [key, value ?? ""]));
  if (Object.keys(body).length === 0) return;
  await call(`/v1/users/${encodeURIComponent(userId)}`, { method: "PUT", asService: true, serviceRefusalIsConflict: true, body });
}

/**
 * Phase 10: a signed-in person changes their own password (PUT /v1/users/password/update/{id}), with the Central
 * session just opened by checking the old password.
 */
async function updatePassword(userId: string, accessToken: string, oldPassword: string, newPassword: string): Promise<void> {
  await call(`/v1/users/password/update/${encodeURIComponent(userId)}`, {
    method: "PUT",
    userToken: accessToken,
    body: { old_password: oldPassword, new_password: newPassword },
  });
}

/** Phase 10: forgot password: a new password with the SMS code (POST /v1/users/reset-password). A refusal is invalid_code. */
async function resetPassword(input: { mobile: string; otp: string; newPassword: string }): Promise<void> {
  try {
    await call("/v1/users/reset-password", { method: "POST", body: { mobile: input.mobile, otp: input.otp, new_password: input.newPassword } });
  } catch (error) {
    if (error instanceof ValidationAppError || error instanceof InvalidCredentialsError || error instanceof NotFoundError) {
      throw new InvalidCodeError(undefined, undefined, { cause: error });
    }
    throw error;
  }
}

/**
 * Changes a person's names in auth-cheche. **Names only:** never mobile, email, status, PIN or password (a Cheche
 * account is the same person in every Cheche app). A refusal of the service token is 409 central_auth_refused.
 */
async function updateUserNames(userId: string, names: StaffNames): Promise<void> {
  await updateUserProfile(userId, names);
}

export const centralAuthClient = {
  getUserProfile,
  updateUserProfile,
  updatePassword,
  resetPassword,
  passwordLogin,
  emailLogin,
  refreshAccessToken,
  logout,
  findUserByMobile,
  getUsersByIds,
  signUpWithPassword,
  verifyCode,
  sendCode,
  signInWithCode,
  createVerifiedUser,
  updateUserNames,
};
