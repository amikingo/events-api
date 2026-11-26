import type { Transaction } from "sequelize";
import { GrantExceedsOwnAccessError, ValidationAppError } from "../errors/app-errors.js";
import { moduleRepository } from "../repositories/module.repository.js";
import { TENANT_GRANTABLE, type GrantableAction } from "../utils/rbac.js";
import { permissionResolutionService } from "./permission-resolution.service.js";

/**
 * The two rules every grant in an organization follows (custom roles, Phase 2c; permission overrides and role
 * templates, Phase 2d), in one place so they can't drift apart:
 * - **Grantable:** a tenant may only hold what TENANT_GRANTABLE allows (never platform modules, never ORGANIZATIONS
 *   create, export only on Guests). A refusal is 400 naming the module or action, checked before anything else.
 * - **Held:** nobody hands out an action they don't hold themselves in their signed-in assignment (403
 *   grant_exceeds_own_access). The Super Admin passes through the permission engine's bypass.
 */
export type GrantEntry = { module_code: string; actions: readonly GrantableAction[] };
export type GrantEditor = { userId: string; assignmentId: string };

/**
 * Refuses anything a tenant may not hold (400, naming the module or action under `pathPrefix`, e.g. "body.grants")
 * and returns the module ids by code. `actions` are the actions the request mentions (granted, or for overrides
 * also denied).
 */
async function assertGrantable(entries: readonly GrantEntry[], pathPrefix: string, transaction: Transaction): Promise<Map<string, string>> {
  const moduleIds = new Map((await moduleRepository.listActiveOrdered({ transaction })).filter((m) => m.is_permission).map((m) => [m.code, m.id]));
  const issues: Array<{ path: string; message: string; code: string }> = [];
  entries.forEach((entry, index) => {
    const allowed = TENANT_GRANTABLE[entry.module_code];
    if (!allowed || !moduleIds.has(entry.module_code)) {
      issues.push({ path: `${pathPrefix}.${index}.module_code`, message: `${entry.module_code} can't be given to an organization's role`, code: "module_not_grantable" });
      return;
    }
    for (const action of entry.actions) {
      if (!allowed.includes(action)) {
        issues.push({ path: `${pathPrefix}.${index}.${action}`, message: `${entry.module_code} can't be given "${action}" in an organization`, code: "action_not_grantable" });
      }
    }
  });
  if (issues.length > 0) throw new ValidationAppError("Request validation failed", { issues });
  return moduleIds;
}

/**
 * Platform roles (Phase 2e) may hold any active permission module, platform modules included, and all 7 actions. A
 * module that doesn't exist or isn't a permission module is a 400 naming it. Returns the module ids by code.
 */
async function assertPlatformGrantable(entries: readonly GrantEntry[], pathPrefix: string, transaction: Transaction): Promise<Map<string, string>> {
  const moduleIds = new Map((await moduleRepository.listActiveOrdered({ transaction })).filter((m) => m.is_permission).map((m) => [m.code, m.id]));
  const issues = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => !moduleIds.has(entry.module_code))
    .map(({ entry, index }) => ({ path: `${pathPrefix}.${index}.module_code`, message: `${entry.module_code} is not an active permission module`, code: "module_not_grantable" }));
  if (issues.length > 0) throw new ValidationAppError("Request validation failed", { issues });
  return moduleIds;
}

/**
 * Every listed action must be one the editor holds (their signed-in assignment): in this organization, or at platform
 * scope when `organizationId` is null (platform roles, Phase 2e).
 */
async function assertHeld(organizationId: string | null, editor: GrantEditor, entries: readonly GrantEntry[]): Promise<void> {
  const scope = organizationId === null ? ({ level: "platform" } as const) : ({ level: "organization", organizationId, branchId: null } as const);
  for (const entry of entries) {
    for (const action of entry.actions) {
      const resolution = await permissionResolutionService.resolvePermission({
        userId: editor.userId,
        assignmentId: editor.assignmentId,
        scope,
        moduleCode: entry.module_code,
        action,
      });
      if (!resolution.allowed) throw new GrantExceedsOwnAccessError(undefined, { module_code: entry.module_code, action });
    }
  }
}

export const grantRules = { assertGrantable, assertPlatformGrantable, assertHeld };
