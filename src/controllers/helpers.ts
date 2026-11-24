import type { Request } from "express";
import { AuthenticationRequiredError } from "../errors/app-errors.js";
import type { StaffAuthContext } from "../middleware/authentication.js";

/** The trusted staff identity. Throws (401) if the route forgot requireStaffAuthentication. */
export function getStaffAuth(req: Request): StaffAuthContext {
  if (req.auth?.kind !== "staff") throw new AuthenticationRequiredError("Staff authentication is required");
  return req.auth;
}

/** Audit actor for created_by / updated_by. */
export function getActorId(req: Request): string | null {
  return req.auth?.userId ?? null;
}
