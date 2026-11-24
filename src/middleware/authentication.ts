import type { RequestHandler } from "express";
import { AuthenticationRequiredError, MalformedBearerTokenError } from "../errors/app-errors.js";
import { authTokenService, type AppStaffIdentity, type CentralIdentity } from "../services/auth-token.service.js";

export type StaffAuthContext = { kind: "staff" } & AppStaffIdentity;
export type CustomerAuthContext = { kind: "customer"; token: string } & CentralIdentity;
export type AuthContext = StaffAuthContext | CustomerAuthContext;

function extractBearerToken(header: string | undefined): string {
  if (!header) throw new AuthenticationRequiredError("Bearer token is required");
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match?.[1]) throw new MalformedBearerTokenError();
  return match[1];
}

/** Staff routes: verifies this API's own staff token (issuer/audience/token_type bound). */
export const requireStaffAuthentication: RequestHandler = (req, _res, next) => {
  const token = extractBearerToken(req.get("authorization"));
  req.auth = { kind: "staff", ...authTokenService.verifyAppStaffToken(token) };
  next();
};

/** Customer routes: verifies a Central Auth access token. */
export const requireCustomerAuthentication: RequestHandler = (req, _res, next) => {
  const token = extractBearerToken(req.get("authorization"));
  req.auth = { kind: "customer", token, ...authTokenService.verifyCentralAccessToken(token) };
  next();
};

/** Public routes that personalize when a customer token is present. A bad token still fails. */
export const optionalCustomerAuthentication: RequestHandler = (req, res, next) => {
  if (!req.get("authorization")) {
    next();
    return;
  }
  requireCustomerAuthentication(req, res, next);
};
