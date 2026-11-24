import type { Request, RequestHandler } from "express";
import { AuthenticationRequiredError, InvalidScopeError, PermissionDeniedError } from "../errors/app-errors.js";
import { permissionResolutionService, type PermissionScope } from "../services/permission-resolution.service.js";
import type { ModuleCode } from "../utils/module-codes.js";
import type { PermissionAction } from "../utils/rbac.js";

export type PermissionRequirement = { moduleCode: ModuleCode; action: PermissionAction };
export type ScopeResolver = (req: Request) => PermissionScope | Promise<PermissionScope>;

export type PermissionOptions = { scope: "platform" | ScopeResolver } & (
  | PermissionRequirement
  | { anyOf: readonly PermissionRequirement[] }
);

const PLATFORM_SCOPE: PermissionScope = { level: "platform" };

/**
 * RBAC gate. Runs AFTER authentication and validate() so scope resolvers read validated params.
 * `scope` is mandatory: "platform" for platform-wide resources, a resolver for tenant resources.
 * Only the assignment the caller is signed in as counts (the staff token's assignment), so a
 * person holding several roles gets exactly what the selected role allows.
 */
export function requirePermission(options: PermissionOptions): RequestHandler {
  const requirements = "anyOf" in options ? options.anyOf : [options];
  if (requirements.length === 0) throw new Error("requirePermission() needs at least one requirement");

  return async (req, _res, next) => {
    const auth = req.auth;
    if (auth?.kind !== "staff") throw new AuthenticationRequiredError("Staff authentication is required");

    const scope = options.scope === "platform" ? PLATFORM_SCOPE : await options.scope(req);

    for (const requirement of requirements) {
      const resolution = await permissionResolutionService.resolvePermission({
        userId: auth.userId,
        assignmentId: auth.assignmentId,
        scope,
        moduleCode: requirement.moduleCode,
        action: requirement.action,
      });
      if (resolution.allowed) {
        req.permissionResolution = resolution;
        next();
        return;
      }
    }
    throw new PermissionDeniedError();
  };
}

function validatedParams(req: Request): Record<string, unknown> {
  return (req.validated?.params ?? {}) as Record<string, unknown>;
}

/** Tenant scope from `/organizations/:organizationId[/.../:branchId]` route params. */
export function organizationScopeFromParams(req: Request): PermissionScope {
  const { organizationId, branchId } = validatedParams(req);
  if (typeof organizationId !== "string") {
    // Fail closed: the route is missing validate({ params }) or the param.
    throw new InvalidScopeError("organizationId is required for this route");
  }
  return { level: "organization", organizationId, branchId: typeof branchId === "string" ? branchId : null };
}
