import type { Request } from "express";
import { AuthenticationRequiredError } from "../errors/app-errors.js";
import type { CustomerAuthContext, StaffAuthContext } from "../middleware/authentication.js";

/** The trusted staff identity. Throws (401) if the route forgot requireStaffAuthentication. */
export function getStaffAuth(req: Request): StaffAuthContext {
  if (req.auth?.kind !== "staff") throw new AuthenticationRequiredError("Staff authentication is required");
  return req.auth;
}

/** The signed-in guest (Phase 6). Throws (401) if the route forgot requireCustomerAuthentication. */
export function getCustomerAuth(req: Request): CustomerAuthContext {
  if (req.auth?.kind !== "customer") throw new AuthenticationRequiredError("Sign in to your Cheche account first");
  return req.auth;
}

/** The guest on a public route with optionalCustomerAuthentication: null when nobody is signed in. */
export function getOptionalCustomerAuth(req: Request): CustomerAuthContext | null {
  return req.auth?.kind === "customer" ? req.auth : null;
}

/** Audit actor for created_by / updated_by. */
export function getActorId(req: Request): string | null {
  return req.auth?.userId ?? null;
}
