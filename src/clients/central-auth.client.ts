import { z } from "zod";
import { authConfig } from "../config/auth.js";
import {
  CentralAuthUnavailableError,
  ConflictError,
  InvalidCredentialsError,
  MalformedCentralAuthResponseError,
  NotFoundError,
  ValidationAppError,
} from "../errors/app-errors.js";
import { requestJson, UpstreamRequestError } from "./http.js";

const UPSTREAM = "central_auth";

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

function upstreamMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "message" in body && typeof body.message === "string" && body.message.trim()) {
    return body.message.trim();
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
      if (init.credentialsFlow && [400, 401, 403].includes(response.status)) throw new InvalidCredentialsError(message);
      if (response.status === 400) throw new ValidationAppError(message);
      if (response.status === 401 || response.status === 403) throw new InvalidCredentialsError(message);
      if (response.status === 404) throw new NotFoundError(message);
      if (response.status === 409) throw new ConflictError(message);
      if (response.status >= 500) throw new CentralAuthUnavailableError();
      throw new MalformedCentralAuthResponseError();
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

async function passwordLogin(input: { mobile: string; password: string }): Promise<CentralTokens> {
  // No Authorization header is forwarded; service_id is server-owned and only sent where the contract requires it.
  const payload = await call("/v1/users/signin/password", { method: "POST", body: input, credentialsFlow: true });
  return parseTokens(payload, { requireRefresh: true });
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

export const centralAuthClient = { passwordLogin, refreshAccessToken, logout };
