import { createHash, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { authConfig } from "../config/auth.js";
import { ExpiredTokenError, InvalidTokenError, UnsupportedTokenError } from "../errors/app-errors.js";

export type IdentityProfile = {
  mobile: string | null;
  firstname: string | null;
  middlename: string | null;
  lastname: string | null;
};

/** Identity proven by a Central Auth access token (customers, and staff before local minting). */
export type CentralIdentity = { userId: string; profile: IdentityProfile; expiresAt: number };

/** Identity + authorization context proven by this API's own staff token. */
export type AppStaffIdentity = {
  userId: string;
  assignmentId: string;
  roleId: string;
  organizationId: string | null;
  branchId: string | null;
  profile: IdentityProfile;
  expiresAt: number;
};

/**
 * Proof that Central Auth confirmed this person recently. While it is valid, staff refresh can
 * skip the Central call (assignments are still re-checked from the database every time).
 */
export type StaffCentralSession = { userId: string; profile: IdentityProfile; centralExpiresAt: number };

/** Never confirm a Central session that ends within this margin: let the next refresh ask Central. */
const CENTRAL_SESSION_EXPIRY_MARGIN_SECONDS = 300;

const optionalText = z.string().nullish().transform((value) => value ?? null);

const CentralAccessClaims = z.looseObject({
  user_id: z.uuid().optional(),
  sub: z.string().optional(),
  token_type: z.literal("access"),
  exp: z.number().int(),
  mobile: optionalText,
  firstname: optionalText,
  middlename: optionalText,
  lastname: optionalText,
});

const AppStaffClaims = z.object({
  sub: z.uuid(),
  token_type: z.literal("staff_access"),
  assignment_id: z.uuid(),
  role_id: z.uuid(),
  organization_id: z.uuid().nullable(),
  branch_id: z.uuid().nullable(),
  exp: z.number().int(),
  mobile: optionalText,
  firstname: optionalText,
  middlename: optionalText,
  lastname: optionalText,
});

const StaffCentralSessionClaims = z.object({
  sub: z.uuid(),
  token_type: z.literal("staff_central_session"),
  central_exp: z.number().int(),
  refresh_token_hash: z.string().regex(/^[0-9a-f]{64}$/),
  mobile: optionalText,
  firstname: optionalText,
  middlename: optionalText,
  lastname: optionalText,
});

function mapJwtError(error: unknown): never {
  if (error instanceof jwt.TokenExpiredError) throw new ExpiredTokenError();
  if (error instanceof jwt.JsonWebTokenError) {
    if (/audience|issuer/i.test(error.message)) throw new UnsupportedTokenError("Token issuer is not supported in this context");
    throw new InvalidTokenError("Token could not be verified");
  }
  throw error;
}

function verifyCentralAccessToken(token: string): CentralIdentity {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, authConfig.centralAuthJwtSecret, {
      algorithms: ["HS256"],
      issuer: authConfig.centralIssuer,
    });
  } catch (error) {
    mapJwtError(error);
  }

  const claims = CentralAccessClaims.safeParse(decoded);
  if (!claims.success) throw new InvalidTokenError("Token payload is malformed");

  const { user_id: userIdClaim, sub } = claims.data;
  if (userIdClaim && sub && userIdClaim !== sub) throw new InvalidTokenError("Token identity is inconsistent");
  const userId = z.uuid().safeParse(userIdClaim ?? sub);
  if (!userId.success) throw new InvalidTokenError("Token identity is invalid");

  const { mobile, firstname, middlename, lastname, exp } = claims.data;
  return { userId: userId.data, profile: { mobile, firstname, middlename, lastname }, expiresAt: exp };
}

function signAppStaffToken(input: {
  userId: string;
  assignment: { id: string; role_id: string; organization_id: string | null; branch_id: string | null };
  profile: IdentityProfile;
  /** Never outlive the upstream identity session. */
  upstreamExpiresAt?: number;
}): { token: string; expiresIn: number } {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const upstreamRemaining = input.upstreamExpiresAt ? Math.max(1, input.upstreamExpiresAt - nowSeconds) : Infinity;
  const expiresIn = Math.max(1, Math.min(authConfig.appTokenTtlSeconds, upstreamRemaining));

  const token = jwt.sign(
    {
      token_type: "staff_access",
      assignment_id: input.assignment.id,
      role_id: input.assignment.role_id,
      organization_id: input.assignment.organization_id,
      branch_id: input.assignment.branch_id,
      ...input.profile,
    },
    authConfig.appTokenSecret,
    {
      algorithm: "HS256",
      expiresIn,
      issuer: authConfig.appIssuer,
      audience: authConfig.appAudience,
      subject: input.userId,
    },
  );
  return { token, expiresIn };
}

function verifyAppStaffToken(token: string): AppStaffIdentity {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, authConfig.appTokenSecret, {
      algorithms: ["HS256"],
      issuer: authConfig.appIssuer,
      audience: authConfig.appAudience,
    });
  } catch (error) {
    mapJwtError(error);
  }

  const claims = AppStaffClaims.safeParse(decoded);
  if (!claims.success) throw new UnsupportedTokenError("Token type is not supported in this context");

  const c = claims.data;
  return {
    userId: c.sub,
    assignmentId: c.assignment_id,
    roleId: c.role_id,
    organizationId: c.organization_id,
    branchId: c.branch_id,
    profile: { mobile: c.mobile, firstname: c.firstname, middlename: c.middlename, lastname: c.lastname },
    expiresAt: c.exp,
  };
}

/**
 * How long a central-session confirmation may live: the configured cap, but never past the Central
 * access token's expiry minus a 5-minute margin. 0 means "do not issue one".
 */
export function centralSessionLifetimeSeconds(ttlSeconds: number, centralExpiresAt: number, nowSeconds: number): number {
  if (ttlSeconds <= 0) return 0;
  const remaining = centralExpiresAt - nowSeconds - CENTRAL_SESSION_EXPIRY_MARGIN_SECONDS;
  return Math.max(0, Math.min(ttlSeconds, remaining));
}

/** Binds a confirmation to the refresh token it was issued with. Only the hash is stored. */
function hashRefreshToken(refreshToken: string): string {
  return createHash("sha256").update(refreshToken).digest("hex");
}

/**
 * Signs the "Central confirmed this person" token with `authConfig.appTokenSecret` (currently the shared
 * APP_AUTH_TOKEN). Its token_type and issuer/audience mean it can never pass as a staff access token or a
 * Central token.
 * Returns null when the feature is off or the Central session is about to end.
 */
function signStaffCentralSession(input: {
  userId: string;
  profile: IdentityProfile;
  centralExpiresAt: number;
  refreshToken: string;
}): { token: string; expiresIn: number } | null {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresIn = centralSessionLifetimeSeconds(authConfig.centralSessionTtlSeconds, input.centralExpiresAt, nowSeconds);
  if (expiresIn <= 0) return null;

  const token = jwt.sign(
    {
      token_type: "staff_central_session",
      central_exp: input.centralExpiresAt,
      refresh_token_hash: hashRefreshToken(input.refreshToken),
      ...input.profile,
    },
    authConfig.appTokenSecret,
    {
      algorithm: "HS256",
      expiresIn,
      issuer: authConfig.appIssuer,
      audience: authConfig.appAudience,
      subject: input.userId,
    },
  );
  return { token, expiresIn };
}

/**
 * Returns the confirmed identity, or null when the token is invalid, expired, of another type, or
 * was issued with a different refresh token. Never throws: a bad confirmation only means "ask Central".
 */
function verifyStaffCentralSession(token: string, refreshToken: string): StaffCentralSession | null {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, authConfig.appTokenSecret, {
      algorithms: ["HS256"],
      issuer: authConfig.appIssuer,
      audience: authConfig.appAudience,
    });
  } catch {
    return null;
  }

  const claims = StaffCentralSessionClaims.safeParse(decoded);
  if (!claims.success) return null;

  const expected = Buffer.from(hashRefreshToken(refreshToken), "hex");
  const actual = Buffer.from(claims.data.refresh_token_hash, "hex");
  if (!timingSafeEqual(expected, actual)) return null;

  const c = claims.data;
  return {
    userId: c.sub,
    profile: { mobile: c.mobile, firstname: c.firstname, middlename: c.middlename, lastname: c.lastname },
    centralExpiresAt: c.central_exp,
  };
}

export const authTokenService = {
  verifyCentralAccessToken,
  signAppStaffToken,
  verifyAppStaffToken,
  signStaffCentralSession,
  verifyStaffCentralSession,
};
