import type { IdentityProfile } from "../services/auth-token.service.js";

/**
 * A guest's session on the public site (Phase 6), shaped like the staff token reply. The access token is
 * auth-cheche's own; the refresh token never appears here (it lives only in the HttpOnly cookie). The mobile is
 * the account's, read from the token or from auth-cheche, never from the browser.
 */
export type CustomerProfileDto = { id: string } & IdentityProfile;

export type CustomerSessionDto = {
  accessToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  user: CustomerProfileDto;
};

export function toCustomerProfileDto(userId: string, profile: IdentityProfile): CustomerProfileDto {
  return { id: userId, mobile: profile.mobile, firstname: profile.firstname, middlename: profile.middlename, lastname: profile.lastname };
}

export function toCustomerSessionDto(input: { token: string; expiresAt: number; userId: string; profile: IdentityProfile }): CustomerSessionDto {
  return {
    accessToken: input.token,
    tokenType: "Bearer",
    expiresIn: Math.max(0, input.expiresAt - Math.floor(Date.now() / 1000)),
    user: toCustomerProfileDto(input.userId, input.profile),
  };
}
