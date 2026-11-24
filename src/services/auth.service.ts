import { centralAuthClient, type CentralTokens } from "../clients/central-auth.client.js";
import {
  AppError,
  BranchInactiveError,
  InvalidCredentialsError,
  InvalidScopeError,
  OrganizationInactiveError,
  RefreshTokenInvalidError,
  RefreshTokenMissingError,
  RoleInactiveError,
  StaffAssignmentNotFoundError,
  StaffContextRequiredError,
  ValidationAppError,
} from "../errors/app-errors.js";
import type { StaffAuthContext } from "../middleware/authentication.js";
import { toStaffSessionDto, toStaffTokenDto, type StaffSessionDto, type StaffTokenDto } from "../mappers/staff-session.mapper.js";
import { userRoleRepository, type AssignmentRow } from "../repositories/user-role.repository.js";
import { logger } from "../utils/logger.js";
import type { StaffLoginInput, StaffRefreshInput, StaffSwitchAssignmentInput } from "../validators/auth.js";
import { authTokenService, type CentralIdentity, type IdentityProfile } from "./auth-token.service.js";
import { isAssignmentUsable, permissionResolutionService } from "./permission-resolution.service.js";

export type RefreshCookiePayload = { token: string; maxAgeSeconds?: number };

/** What the controller does with the staff "Central confirmed" cookie after login or refresh. */
export type CentralSessionCookieAction =
  | { action: "set"; token: string; maxAgeSeconds: number }
  | { action: "keep" }
  | { action: "clear" };

export type StaffTokenResult = {
  data: StaffTokenDto;
  /** null keeps the existing refresh cookie. */
  refreshCookie: RefreshCookiePayload | null;
  centralSessionCookie: CentralSessionCookieAction;
};

/** Mirrors the DB scope-guard trigger with user-facing errors. */
function assertAssignmentConsistent(assignment: AssignmentRow): void {
  if (!assignment.role.is_active) throw new RoleInactiveError();
  if (assignment.organization_id === null) {
    if (assignment.branch_id !== null) throw new InvalidScopeError("Platform assignments cannot include a branch");
    if (assignment.role.organization_id !== null) throw new InvalidScopeError("Platform assignments must use platform roles");
  } else if (assignment.role.organization_id !== assignment.organization_id) {
    throw new InvalidScopeError("The assignment role must belong to the same organization");
  }
  if (assignment.organization && !assignment.organization.is_active) throw new OrganizationInactiveError();
  if (assignment.branch && !assignment.branch.is_active) throw new BranchInactiveError();
}

/** Most specific first: branch > organization > platform; ties broken by id for determinism. */
function selectDefaultAssignment(assignments: AssignmentRow[]): AssignmentRow | undefined {
  const specificity = (assignment: AssignmentRow) => (assignment.branch_id ? 2 : assignment.organization_id ? 1 : 0);
  return [...assignments].sort((left, right) => specificity(right) - specificity(left) || left.id.localeCompare(right.id))[0];
}

async function loadUsableAssignments(userId: string): Promise<AssignmentRow[]> {
  return (await userRoleRepository.listActiveAssignmentsByUser(userId)).filter(isAssignmentUsable);
}

function issueStaffToken(input: {
  userId: string;
  profile: IdentityProfile;
  assignment: AssignmentRow;
  assignments: AssignmentRow[];
  upstreamExpiresAt?: number;
}): StaffTokenDto {
  assertAssignmentConsistent(input.assignment);
  const { token, expiresIn } = authTokenService.signAppStaffToken({
    userId: input.userId,
    assignment: input.assignment,
    profile: input.profile,
    ...(input.upstreamExpiresAt === undefined ? {} : { upstreamExpiresAt: input.upstreamExpiresAt }),
  });
  return toStaffTokenDto({ token, expiresIn, ...input });
}

function toRefreshCookie(tokens: CentralTokens): RefreshCookiePayload | null {
  if (!tokens.refreshToken) return null; // access-only renewal keeps the existing cookie
  return tokens.refreshExpiresIn
    ? { token: tokens.refreshToken, maxAgeSeconds: tokens.refreshExpiresIn }
    : { token: tokens.refreshToken };
}

/**
 * Central Auth has just vouched for this person (login or Central refresh): issue a fresh
 * confirmation bound to the refresh token the cookie will hold. Cleared when the feature is off.
 */
function confirmCentralSession(identity: CentralIdentity, refreshToken: string | null): CentralSessionCookieAction {
  if (!refreshToken) return { action: "clear" };
  const signed = authTokenService.signStaffCentralSession({
    userId: identity.userId,
    profile: identity.profile,
    centralExpiresAt: identity.expiresAt,
    refreshToken,
  });
  return signed ? { action: "set", token: signed.token, maxAgeSeconds: signed.expiresIn } : { action: "clear" };
}

async function staffLogin(input: StaffLoginInput): Promise<StaffTokenResult> {
  const tokens = await centralAuthClient.passwordLogin(input);
  const identity = authTokenService.verifyCentralAccessToken(tokens.accessToken);

  const assignments = await loadUsableAssignments(identity.userId);
  const assignment = selectDefaultAssignment(assignments);
  if (!assignment) throw new StaffAssignmentNotFoundError("No active staff assignment exists for this account");

  return {
    data: issueStaffToken({
      userId: identity.userId,
      profile: identity.profile,
      assignment,
      assignments,
      upstreamExpiresAt: identity.expiresAt,
    }),
    refreshCookie: toRefreshCookie(tokens),
    centralSessionCookie: confirmCentralSession(identity, tokens.refreshToken),
  };
}

/**
 * Staff refresh. While a valid confirmation cookie (bound to this refresh token) exists, Central Auth
 * is not called and both cookies stay as they are; otherwise Central refreshes and a new confirmation
 * is issued. Either way the assignments are re-read from the database.
 */
async function refreshStaffSession(
  input: StaffRefreshInput,
  refreshToken: string | null,
  centralSessionToken: string | null,
): Promise<StaffTokenResult> {
  if (!refreshToken) throw new RefreshTokenMissingError();

  const confirmed = centralSessionToken ? authTokenService.verifyStaffCentralSession(centralSessionToken, refreshToken) : null;
  if (confirmed) {
    const identity: CentralIdentity = { userId: confirmed.userId, profile: confirmed.profile, expiresAt: confirmed.centralExpiresAt };
    return { data: await issueRefreshedStaffToken(input, identity), refreshCookie: null, centralSessionCookie: { action: "keep" } };
  }

  let tokens: CentralTokens;
  try {
    tokens = await centralAuthClient.refreshAccessToken(refreshToken);
  } catch (error) {
    if (error instanceof InvalidCredentialsError || error instanceof ValidationAppError) throw new RefreshTokenInvalidError();
    throw error;
  }
  const identity = authTokenService.verifyCentralAccessToken(tokens.accessToken);
  return {
    data: await issueRefreshedStaffToken(input, identity),
    refreshCookie: toRefreshCookie(tokens),
    // A rotated refresh token replaces the cookie; otherwise the existing one stays and the confirmation binds to it.
    centralSessionCookie: confirmCentralSession(identity, tokens.refreshToken ?? refreshToken),
  };
}

/** Re-reads the person's assignments from the database and picks the one to sign the new token for. */
async function issueRefreshedStaffToken(input: StaffRefreshInput, identity: CentralIdentity): Promise<StaffTokenDto> {
  const assignments = await loadUsableAssignments(identity.userId);

  let assignment: AssignmentRow | undefined;
  if (input?.assignment_id) {
    assignment = assignments.find((item) => item.id === input.assignment_id);
    if (!assignment) throw new StaffAssignmentNotFoundError("Selected staff assignment does not exist or is inactive");
  } else if (assignments.length === 1) {
    assignment = assignments[0];
  } else if (assignments.length === 0) {
    throw new StaffAssignmentNotFoundError("No active staff assignment exists for this account");
  } else {
    throw new StaffContextRequiredError("assignment_id is required when more than one active assignment exists", {
      count: assignments.length,
    });
  }
  if (!assignment) throw new StaffAssignmentNotFoundError();

  return issueStaffToken({
    userId: identity.userId,
    profile: identity.profile,
    assignment,
    assignments,
    upstreamExpiresAt: identity.expiresAt,
  });
}

async function switchStaffAssignment(input: StaffSwitchAssignmentInput, auth: StaffAuthContext): Promise<StaffTokenDto> {
  const assignments = await loadUsableAssignments(auth.userId);
  const assignment = assignments.find((item) => item.id === input.assignment_id);
  if (!assignment) throw new StaffAssignmentNotFoundError("Selected staff assignment does not exist or is inactive");
  return issueStaffToken({ userId: auth.userId, profile: auth.profile, assignment, assignments, upstreamExpiresAt: auth.expiresAt });
}

/** Session hydration for the staff app. Revalidates the assignment from the DB; never trusts the token alone. */
async function getCurrentStaffSession(auth: StaffAuthContext): Promise<StaffSessionDto> {
  const assignment = await userRoleRepository.findActiveAssignmentByIdAndUser(auth.assignmentId, auth.userId);
  if (!assignment) throw new StaffAssignmentNotFoundError("No active staff assignment exists for this account");
  assertAssignmentConsistent(assignment);

  const [{ permissions, navigation }, assignments] = await Promise.all([
    permissionResolutionService.resolveStaffSession(assignment),
    loadUsableAssignments(auth.userId),
  ]);

  return toStaffSessionDto({ userId: auth.userId, profile: auth.profile, assignment, assignments, permissions, navigation });
}

/**
 * Best-effort logout at Central Auth. Never throws: a Central failure must not block the user
 * from signing out (the caller clears the cookie regardless). Logs the failure kind only,
 * never the token. Returns whether Central confirmed the revocation.
 */
async function revokeCentralSession(refreshToken: string | null): Promise<boolean> {
  if (!refreshToken) return false;
  try {
    await centralAuthClient.logout(refreshToken);
    return true;
  } catch (error) {
    const reason =
      error instanceof AppError
        ? { code: error.code, statusCode: error.statusCode }
        : { type: error instanceof Error ? error.name : typeof error };
    logger.warn(reason, "Central Auth logout failed; local session cleared anyway");
    return false;
  }
}

/** Errors after which the refresh cookie is useless and must be cleared. */
function shouldClearRefreshCookie(error: unknown): boolean {
  return (
    error instanceof RefreshTokenInvalidError ||
    error instanceof StaffAssignmentNotFoundError ||
    error instanceof RoleInactiveError ||
    error instanceof OrganizationInactiveError ||
    error instanceof BranchInactiveError ||
    error instanceof InvalidScopeError
  );
}

export const authService = {
  staffLogin,
  refreshStaffSession,
  switchStaffAssignment,
  getCurrentStaffSession,
  revokeCentralSession,
  shouldClearRefreshCookie,
};
