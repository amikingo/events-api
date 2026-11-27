import { centralAuthClient, type CentralTokens } from "../clients/central-auth.client.js";
import {
  AccountExistsError,
  AccountNotFoundError,
  AppError,
  ConflictError,
  InvalidCodeError,
  InvalidCredentialsError,
  NotFoundError,
  RefreshTokenInvalidError,
  RefreshTokenMissingError,
  ValidationAppError,
} from "../errors/app-errors.js";
import type { CustomerAuthContext } from "../middleware/authentication.js";
import { toCustomerProfileDto, toCustomerSessionDto, type CustomerProfileDto, type CustomerSessionDto } from "../mappers/customer-session.mapper.js";
import { logger } from "../utils/logger.js";
import { normalizeEthiopianMobile } from "../utils/mobile.js";
import type {
  CustomerCodeLoginInput,
  CustomerConfirmSignUpInput,
  CustomerPasswordLoginInput,
  CustomerSignUpInput,
} from "../validators/customer-auth.js";
import { authTokenService, type CentralIdentity, type IdentityProfile } from "./auth-token.service.js";
import type { RefreshCookiePayload } from "./auth.service.js";

/**
 * Guest accounts on the public site (Phase 6, decided 25 November 2026). Guests use Cheche accounts in auth-cheche;
 * this API makes every auth-cheche call, so the browser never talks to auth-cheche and never sees a refresh token
 * (HttpOnly cookie only). The guest's access token is auth-cheche's own, checked by requireCustomerAuthentication.
 * - Sign-up: name, mobile and password; a code arrives by SMS. Confirming sends the code and the password again:
 *   the account is confirmed, then signed in with the password, which works whether or not auth-cheche lets the
 *   same code be used twice.
 * - Sign-in: mobile and an SMS code, or mobile and password.
 * - The mobile always comes from the account (the token, or auth-cheche by user id), never from the browser.
 */
export type CustomerSessionResult = { data: CustomerSessionDto; refreshCookie: RefreshCookiePayload | null };

function toRefreshCookie(tokens: CentralTokens): RefreshCookiePayload | null {
  if (!tokens.refreshToken) return null;
  return tokens.refreshExpiresIn ? { token: tokens.refreshToken, maxAgeSeconds: tokens.refreshExpiresIn } : { token: tokens.refreshToken };
}

/** auth-cheche's mobile, or the original text when it isn't an Ethiopian mobile. */
function normalizedMobile(mobile: string | null): string | null {
  if (!mobile) return null;
  return normalizeEthiopianMobile(mobile) ?? mobile;
}

/**
 * The account's mobile: from the token when it carries one, otherwise from auth-cheche by user id (specific_users,
 * with this API's service token). Null only when auth-cheche has none or can't be reached and `required` is false.
 */
async function accountMobile(identity: CentralIdentity, { required }: { required: boolean }): Promise<string | null> {
  const fromToken = normalizedMobile(identity.profile.mobile);
  if (fromToken) return fromToken;
  try {
    const [user] = await centralAuthClient.getUsersByIds([identity.userId]);
    const fromAccount = normalizedMobile(user?.mobile ?? null);
    if (fromAccount || !required) return fromAccount;
  } catch (error) {
    if (required) throw error;
    logger.warn({ code: error instanceof AppError ? error.code : "unknown" }, "Could not read the guest's mobile from Central Auth");
    return null;
  }
  throw new ValidationAppError("Your Cheche account has no mobile number. Add one in your Cheche account first.");
}

/** The account's profile with the mobile filled in from auth-cheche when the token has none (best effort). */
async function accountProfile(identity: CentralIdentity): Promise<IdentityProfile> {
  return { ...identity.profile, mobile: await accountMobile(identity, { required: false }) };
}

async function sessionFrom(tokens: CentralTokens): Promise<CustomerSessionResult> {
  const identity = authTokenService.verifyCentralAccessToken(tokens.accessToken);
  return {
    data: toCustomerSessionDto({ token: tokens.accessToken, expiresAt: identity.expiresAt, userId: identity.userId, profile: await accountProfile(identity) }),
    refreshCookie: toRefreshCookie(tokens),
  };
}

/** auth-cheche's refusal, in this API's codes. auth-cheche's own text is kept when it gave one. */
function mapAccountError(error: unknown, codeStep: boolean): never {
  if (error instanceof ConflictError) throw new AccountExistsError(undefined, undefined, { cause: error });
  if (error instanceof NotFoundError) throw new AccountNotFoundError(undefined, undefined, { cause: error });
  if (codeStep && (error instanceof ValidationAppError || error instanceof InvalidCredentialsError)) {
    throw new InvalidCodeError(error.message || undefined, undefined, { cause: error });
  }
  throw error;
}

async function signUp(input: CustomerSignUpInput): Promise<void> {
  try {
    await centralAuthClient.signUpWithPassword({ mobile: input.mobile, password: input.password, firstname: input.first_name, lastname: input.last_name });
  } catch (error) {
    mapAccountError(error, false);
  }
}

/** A code by SMS: a new one for an unconfirmed sign-up, or one to sign in with. auth-cheche's refusal text is shown. */
async function sendCode(mobile: string): Promise<void> {
  try {
    await centralAuthClient.sendCode(mobile);
  } catch (error) {
    mapAccountError(error, false);
  }
}

async function confirmSignUp(input: CustomerConfirmSignUpInput): Promise<CustomerSessionResult> {
  try {
    await centralAuthClient.verifyCode({ mobile: input.mobile, otp: input.otp });
  } catch (error) {
    mapAccountError(error, true);
  }
  return sessionFrom(await centralAuthClient.passwordLogin({ mobile: input.mobile, password: input.password }));
}

async function loginWithCode(input: CustomerCodeLoginInput): Promise<CustomerSessionResult> {
  let tokens: CentralTokens;
  try {
    tokens = await centralAuthClient.signInWithCode({ mobile: input.mobile, otp: input.otp });
  } catch (error) {
    mapAccountError(error, true);
  }
  return sessionFrom(tokens);
}

/** Refusals get the fixed "Invalid mobile number, email or password" text, as for staff. */
async function loginWithPassword(input: CustomerPasswordLoginInput): Promise<CustomerSessionResult> {
  return sessionFrom(await centralAuthClient.passwordLogin({ mobile: input.mobile, password: input.password }));
}

/** Every guest refresh asks auth-cheche (there is no local confirmation cookie as for staff). */
async function refreshSession(refreshToken: string | null): Promise<CustomerSessionResult> {
  if (!refreshToken) throw new RefreshTokenMissingError();
  let tokens: CentralTokens;
  try {
    tokens = await centralAuthClient.refreshAccessToken(refreshToken);
  } catch (error) {
    if (error instanceof InvalidCredentialsError || error instanceof ValidationAppError) throw new RefreshTokenInvalidError();
    throw error;
  }
  return sessionFrom(tokens);
}

async function getCurrentCustomer(auth: CustomerAuthContext): Promise<CustomerProfileDto> {
  return toCustomerProfileDto(auth.userId, await accountProfile(auth));
}

/**
 * Phase 10: a signed-in guest edits their own names in auth-cheche (only changed fields; middlename "" clears it). The
 * guest's access token is auth-cheche's own and still carries the old names: refresh the session for a token with the
 * new ones. The reply is the profile as it is now.
 */
async function updateOwnNames(auth: CustomerAuthContext, input: { firstname: string; middlename?: string | null | undefined; lastname: string }): Promise<CustomerProfileDto> {
  const current = await centralAuthClient.getUserProfile(auth.userId);
  const text = (value: string | null | undefined) => (value ?? "").trim();
  const patch: { firstname?: string; middlename?: string; lastname?: string } = {};
  if (text(input.firstname) !== text(current?.firstname)) patch.firstname = text(input.firstname);
  if (input.middlename !== undefined && text(input.middlename) !== text(current?.middlename)) patch.middlename = text(input.middlename);
  if (text(input.lastname) !== text(current?.lastname)) patch.lastname = text(input.lastname);
  if (Object.keys(patch).length > 0) await centralAuthClient.updateUserProfile(auth.userId, patch);
  return toCustomerProfileDto(auth.userId, {
    mobile: current?.mobile ?? auth.profile.mobile,
    firstname: patch.firstname ?? current?.firstname ?? null,
    middlename: patch.middlename === undefined ? (current?.middlename ?? null) : patch.middlename || null,
    lastname: patch.lastname ?? current?.lastname ?? null,
  });
}

export const customerAuthService = {
  updateOwnNames,
  signUp,
  sendCode,
  confirmSignUp,
  loginWithCode,
  loginWithPassword,
  refreshSession,
  getCurrentCustomer,
  accountMobile,
};
