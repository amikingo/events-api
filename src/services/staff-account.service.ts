import { centralAuthClient, type CentralProfile, type ProfilePatch } from "../clients/central-auth.client.js";
import { InvalidCodeError, InvalidCredentialsError, ValidationAppError } from "../errors/app-errors.js";
import type { StaffAuthContext } from "../middleware/authentication.js";
import { userRoleRepository } from "../repositories/user-role.repository.js";
import { logger } from "../utils/logger.js";
import { normalizeEthiopianMobile } from "../utils/mobile.js";
import { authTokenService } from "./auth-token.service.js";
import { isAssignmentUsable } from "./permission-resolution.service.js";

/**
 * A staff member's own account (Phase 10), as bookings_api: names and passwords live in auth-cheche (one Cheche
 * account is the same person in every Cheche app), so this API passes the change through.
 * - Own names: only changed fields are sent; the reply carries a refreshed staff token, because ours holds the names.
 * - Change password: the old password is checked by signing in to auth-cheche, then changed with that session.
 * - Forgot password: a code is sent only to a mobile with an active staff assignment, but the reply is always the
 *   same, so nobody can find out who is staff; the reset checks the assignment again.
 */

export type OwnNamesInput = { firstname: string; middlename?: string | null | undefined; lastname: string };
export type OwnProfileDto = {
  profile: { firstname: string | null; middlename: string | null; lastname: string | null; mobile: string | null; email: string | null };
  changed: boolean;
  /** A staff token with the new names (same assignment, same expiry), to replace the one in use. */
  access_token: string;
  expires_in: number;
};

const text = (value: string | null | undefined): string => (value ?? "").trim();

/** The names that differ from what auth-cheche has now (middlename "" clears it). */
function changedNames(current: Pick<CentralProfile, "firstname" | "middlename" | "lastname"> | null, input: OwnNamesInput): ProfilePatch {
  const patch: ProfilePatch = {};
  if (text(input.firstname) !== text(current?.firstname)) patch.firstname = text(input.firstname);
  if (input.middlename !== undefined && text(input.middlename) !== text(current?.middlename)) patch.middlename = text(input.middlename);
  if (text(input.lastname) !== text(current?.lastname)) patch.lastname = text(input.lastname);
  return patch;
}

/** Edits the signed-in staff member's own names and gives back a token that carries them. */
async function updateOwnNames(auth: StaffAuthContext, input: OwnNamesInput): Promise<OwnProfileDto> {
  const current = await centralAuthClient.getUserProfile(auth.userId);
  const patch = changedNames(current, input);
  const changed = Object.keys(patch).length > 0;
  if (changed) await centralAuthClient.updateUserProfile(auth.userId, patch);
  const names = {
    firstname: patch.firstname ?? current?.firstname ?? null,
    middlename: patch.middlename === undefined ? (current?.middlename ?? null) : patch.middlename || null,
    lastname: patch.lastname ?? current?.lastname ?? null,
  };
  const { token, expiresIn } = authTokenService.signAppStaffToken({
    userId: auth.userId,
    assignment: { id: auth.assignmentId, role_id: auth.roleId, organization_id: auth.organizationId, branch_id: auth.branchId },
    profile: { mobile: auth.profile.mobile, ...names },
    upstreamExpiresAt: auth.expiresAt,
  });
  return { profile: { ...names, mobile: auth.profile.mobile, email: current?.email ?? null }, changed, access_token: token, expires_in: expiresIn };
}

/** Changes the signed-in staff member's password after checking the old one. A wrong old password is a 400 on it. */
async function changePassword(auth: StaffAuthContext, input: { old_password: string; new_password: string }): Promise<{ updated: true }> {
  if (!auth.profile.mobile) throw new ValidationAppError("This account has no mobile number to check the password against");
  let session;
  try {
    session = await centralAuthClient.passwordLogin({ mobile: auth.profile.mobile, password: input.old_password });
  } catch (error) {
    if (error instanceof InvalidCredentialsError) {
      // The staff member is signed in: a wrong current password is a form error, not a lost session.
      throw new ValidationAppError("Request validation failed", { issues: [{ path: "body.old_password", message: "The current password is wrong", code: "wrong_password" }] });
    }
    throw error;
  }
  await centralAuthClient.updatePassword(auth.userId, session.accessToken, input.old_password, input.new_password);
  return { updated: true };
}

const RESET_SENT = { sent: true, message: "If this mobile has staff access, a code has been sent to it." } as const;

/** The account behind a mobile, when it has an active, usable staff assignment (anywhere, platform included). */
async function staffAccountOf(mobile: string): Promise<string | null> {
  const user = await centralAuthClient.findUserByMobile(mobile);
  if (!user) return null;
  const assignments = (await userRoleRepository.listActiveAssignmentsByUser(user.userId)).filter(isAssignmentUsable);
  return assignments.length > 0 ? user.userId : null;
}

/** Forgot password: sends a code only to staff, and always answers the same. */
async function requestPasswordReset(input: { mobile: string }): Promise<typeof RESET_SENT> {
  const mobile = normalizeEthiopianMobile(input.mobile);
  if (mobile === null) return RESET_SENT;
  try {
    if ((await staffAccountOf(mobile)) !== null) await centralAuthClient.sendCode(mobile);
  } catch (error) {
    // Still the same reply: a failure must not reveal whether the mobile has staff access.
    logger.warn({ err: error instanceof Error ? { name: error.name, message: error.message } : error }, "Couldn't send a staff password reset code");
  }
  return RESET_SENT;
}

/** Resets the password with the code; the mobile must still have staff access. */
async function resetPassword(input: { mobile: string; otp: string; new_password: string }): Promise<{ reset: true }> {
  const mobile = normalizeEthiopianMobile(input.mobile);
  if (mobile === null || (await staffAccountOf(mobile)) === null) throw new InvalidCodeError();
  await centralAuthClient.resetPassword({ mobile, otp: input.otp, newPassword: input.new_password });
  return { reset: true };
}

export const staffAccountService = { updateOwnNames, changePassword, requestPasswordReset, resetPassword };
