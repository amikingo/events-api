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

async function call(path: string, init: { method: "GET" | "POST"; body?: unknown; credentialsFlow?: boolean }) {
  try {
    const response = await requestJson(new URL(`${authConfig.centralAuthUrl}${path}`), {
      upstream: UPSTREAM,
      timeoutMs: authConfig.centralAuthTimeoutMs,
      method: init.method,
      body: init.body,
    });

    if (!response.ok) {
      const message = upstreamMessage(response.body, "Central Auth rejected the request");
      // For the server log only (the error handler logs the cause); never sent to the client.
      const cause = new Error(`Central Auth ${response.status}: ${message}`);
      // auth-cheche answers 429 both for its per-IP rate limit and for an account locked after failed attempts.
      if (response.status === 429) throw new CentralAuthRateLimitedError(undefined, undefined, { cause });
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

export const centralAuthClient = { passwordLogin, emailLogin, refreshAccessToken, logout };
