import { InvalidScopeError } from "../errors/app-errors.js";
import type { ModuleRow } from "../models/module.js";
import type { OrganizationRow } from "../models/organization.js";
import type { RoleModuleAccessRow } from "../models/role-module-access.js";
import type { UserModuleAccessRow } from "../models/user-module-access.js";
import { branchRepository } from "../repositories/branch.repository.js";
import { moduleRepository } from "../repositories/module.repository.js";
import { organizationRepository } from "../repositories/organization.repository.js";
import { roleModuleAccessRepository } from "../repositories/role-module-access.repository.js";
import { userModuleAccessRepository } from "../repositories/user-module-access.repository.js";
import { userRoleRepository, type AssignmentRow } from "../repositories/user-role.repository.js";
import { MODULE_CODES } from "../utils/module-codes.js";
import {
  ACTION_TO_FIELD,
  FULL_PERMISSION,
  PERMISSION_ACTIONS,
  SUPER_ADMIN_ROLE_CODE,
  type PermissionAction,
  type PermissionMatrix,
} from "../utils/rbac.js";

/**
 * Every permission check names its scope explicitly. There is no fallback to
 * "the caller's own organization": platform-wide resources use { level: "platform" },
 * which tenant assignments can never satisfy.
 */
export type PermissionScope =
  | { level: "platform" }
  | { level: "organization"; organizationId: string; branchId: string | null };

export type PermissionSource =
  | "module_unavailable"
  | "no_assignment"
  | "super_admin_bypass"
  | "feature_disabled"
  | "user_override_allow"
  | "user_override_deny"
  | "role_permission"
  | "default_deny";

export type PermissionResolution = {
  allowed: boolean;
  source: PermissionSource;
  scope: PermissionScope;
  roleIds: string[];
};

export type NavigationNode = {
  id: string;
  code: string;
  module_name: string;
  route_name: string | null;
  icon: string | null;
  parent_id: string | null;
  sno: number;
  children: NavigationNode[];
};

export function isAssignmentUsable(assignment: AssignmentRow): boolean {
  return (
    assignment.is_active &&
    assignment.role.is_active &&
    (assignment.organization?.is_active ?? true) &&
    (assignment.branch?.is_active ?? true)
  );
}

export function isPlatformSuperAdmin(assignment: AssignmentRow): boolean {
  return (
    assignment.organization_id === null &&
    assignment.branch_id === null &&
    assignment.role.organization_id === null &&
    assignment.role.code === SUPER_ADMIN_ROLE_CODE
  );
}

/** Platform assignments act everywhere; tenant assignments only inside their own organization (and branch). */
export function appliesToScope(assignment: AssignmentRow, scope: PermissionScope): boolean {
  const isPlatformAssignment = assignment.organization_id === null && assignment.role.organization_id === null;
  if (isPlatformAssignment) return true;
  if (scope.level === "platform") return false;
  if (assignment.organization_id !== scope.organizationId) return false;
  if (assignment.role.organization_id !== scope.organizationId) return false;
  if (assignment.branch_id === null) return true; // organization-wide assignment covers every branch
  return scope.branchId !== null && assignment.branch_id === scope.branchId;
}

/**
 * Organization feature gates (Phase 2e, decided 26 November 2026): an organization setting that switches part of a
 * module off for that organization's staff, whatever their role or overrides say. A gated action is denied with
 * source `feature_disabled`, shows as false in `/me` and, when `view` is gated, leaves the menu. The platform Super
 * Admin is exempt (the bypass runs first). Adding a gate is one entry here.
 *
 * Branches: without branches an organization keeps one hidden default branch, so everything but `create` is off.
 * `create` stays open because adding the first branch is what switches branches on.
 */
type FeatureGate = { moduleCode: string; actions: readonly PermissionAction[]; isOff: (organization: OrganizationRow) => boolean };

export const FEATURE_GATES: readonly FeatureGate[] = [
  {
    moduleCode: MODULE_CODES.BRANCHES,
    actions: PERMISSION_ACTIONS.filter((action) => action !== "create"),
    isOff: (organization) => !organization.has_branches,
  },
];

/** The actions of this module that the organization's settings switch off (empty when nothing is gated). */
export function gatedActions(moduleCode: string, organization: OrganizationRow | null): Set<PermissionAction> {
  const off = new Set<PermissionAction>();
  if (!organization) return off;
  for (const gate of FEATURE_GATES) {
    if (gate.moduleCode === moduleCode && gate.isOff(organization)) gate.actions.forEach((action) => off.add(action));
  }
  return off;
}

/** Among equally specific explicit overrides, deny wins. */
function mergeExplicit(values: boolean[]): boolean | null {
  if (values.includes(false)) return false;
  if (values.includes(true)) return true;
  return null;
}

async function resolvePermission(input: {
  userId: string;
  /**
   * The assignment the caller is signed in as (the staff token's assignment_id): only that
   * assignment counts. `null` combines all of the user's assignments and is for internal
   * callers only, never for HTTP requests. Required on purpose, so no caller can forget it.
   */
  assignmentId: string | null;
  scope: PermissionScope;
  moduleCode: string;
  action: PermissionAction;
}): Promise<PermissionResolution> {
  const { userId, assignmentId, scope, moduleCode, action } = input;

  const permissionModule = await moduleRepository.findActivePermissionByCode(moduleCode);
  if (!permissionModule) {
    return { allowed: false, source: "module_unavailable", scope, roleIds: [] };
  }

  if (scope.level === "organization" && scope.branchId) {
    const branch = await branchRepository.findByOrganizationAndId(scope.organizationId, scope.branchId);
    if (!branch) throw new InvalidScopeError("branchId does not belong to organizationId");
  }

  const assignments = await userRoleRepository.listActiveAssignmentsByUser(userId);
  const candidates = assignmentId === null ? assignments : assignments.filter((assignment) => assignment.id === assignmentId);
  const applicable = candidates.filter((assignment) => isAssignmentUsable(assignment) && appliesToScope(assignment, scope));
  const roleIds = [...new Set(applicable.map((assignment) => assignment.role_id))];

  if (applicable.length === 0) {
    return { allowed: false, source: "no_assignment", scope, roleIds };
  }
  if (applicable.some(isPlatformSuperAdmin)) {
    return { allowed: true, source: "super_admin_bypass", scope, roleIds };
  }

  // Organization feature gates come before overrides and role grants (the Super Admin is exempt, handled above).
  // The organization is loaded only when a gate could apply: from the signed-in assignment, or for platform staff
  // acting in an organization, from the database.
  if (scope.level === "organization" && FEATURE_GATES.some((gate) => gate.moduleCode === moduleCode && gate.actions.includes(action))) {
    const organization =
      applicable.find((assignment) => assignment.organization?.id === scope.organizationId)?.organization ??
      (await organizationRepository.findById(scope.organizationId));
    if (gatedActions(moduleCode, organization).has(action)) {
      return { allowed: false, source: "feature_disabled", scope, roleIds };
    }
  }

  const field = ACTION_TO_FIELD[action];
  const [overrides, roleAccesses] = await Promise.all([
    userModuleAccessRepository.listActiveByUserRoleIdsAndModule(
      applicable.map((assignment) => assignment.id),
      permissionModule.id,
    ),
    roleModuleAccessRepository.listByRoleIdsAndModule(roleIds, permissionModule.id),
  ]);
  const overrideByAssignmentId = new Map(overrides.map((row) => [row.user_role_id, row]));

  // Branch-specific assignments are more specific than organization-wide/platform ones.
  const branchId = scope.level === "organization" ? scope.branchId : null;
  const isBranchSpecific = (assignment: AssignmentRow) => branchId !== null && assignment.branch_id === branchId;
  const buckets = [applicable.filter(isBranchSpecific), applicable.filter((assignment) => !isBranchSpecific(assignment))];

  for (const bucket of buckets) {
    const explicit = bucket
      .map((assignment) => overrideByAssignmentId.get(assignment.id)?.[field])
      .filter((value): value is boolean => typeof value === "boolean");
    const decision = mergeExplicit(explicit);
    if (decision !== null) {
      return { allowed: decision, source: decision ? "user_override_allow" : "user_override_deny", scope, roleIds };
    }
  }

  const allowed = roleAccesses.some((row) => row[field]);
  return { allowed, source: allowed ? "role_permission" : "default_deny", scope, roleIds };
}

function effectivePermission(
  roleAccess: RoleModuleAccessRow | undefined,
  override: UserModuleAccessRow | undefined,
): PermissionMatrix {
  const matrix = {} as PermissionMatrix;
  for (const action of PERMISSION_ACTIONS) {
    const field = ACTION_TO_FIELD[action];
    const overrideValue = override?.[field];
    matrix[action] = typeof overrideValue === "boolean" ? overrideValue : roleAccess?.[field] === true;
  }
  return matrix;
}

function isVisibleDestination(module: ModuleRow, permission: PermissionMatrix | undefined): boolean {
  if (!module.is_menu) return false;
  if (module.is_permission) return permission?.view === true;
  return module.route_name !== null; // navigation-only destination
}

function canContainVisibleItems(module: ModuleRow, permission: PermissionMatrix | undefined): boolean {
  if (!module.is_menu) return false;
  if (module.is_permission) return permission?.view === true;
  return true; // container: visible only because a descendant is visible
}

/** Backend-owned navigation: nested by parent_id, ordered by sno, filtered by effective `view`. */
export function buildNavigationTree(modules: ModuleRow[], permissions: Record<string, PermissionMatrix>): NavigationNode[] {
  const byId = new Map(modules.map((module) => [module.id, module]));
  const visibleIds = new Set<string>();

  for (const module of modules) {
    if (!isVisibleDestination(module, permissions[module.code])) continue;
    const seen = new Set<string>();
    let current: ModuleRow | undefined = module;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (canContainVisibleItems(current, permissions[current.code])) visibleIds.add(current.id);
      current = current.parent_id ? byId.get(current.parent_id) : undefined;
    }
  }

  const nearestVisibleParent = (module: ModuleRow): string | null => {
    const seen = new Set<string>();
    let parentId = module.parent_id;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      if (visibleIds.has(parentId)) return parentId;
      parentId = byId.get(parentId)?.parent_id ?? null;
    }
    return null;
  };

  const childrenByParent = new Map<string | null, ModuleRow[]>();
  for (const module of modules) {
    if (!visibleIds.has(module.id)) continue;
    const parentId = nearestVisibleParent(module);
    childrenByParent.set(parentId, [...(childrenByParent.get(parentId) ?? []), module]);
  }

  const order = (left: ModuleRow, right: ModuleRow) =>
    left.sno - right.sno || left.module_name.localeCompare(right.module_name) || left.code.localeCompare(right.code);

  const toNode = (module: ModuleRow): NavigationNode => ({
    id: module.id,
    code: module.code,
    module_name: module.module_name,
    route_name: module.route_name,
    icon: module.icon,
    parent_id: module.parent_id,
    sno: module.sno,
    children: (childrenByParent.get(module.id) ?? []).sort(order).map(toNode),
  });

  return (childrenByParent.get(null) ?? []).sort(order).map(toNode);
}

/** Flat permission map (keyed by module code) + nested navigation for one assignment. */
async function resolveStaffSession(
  assignment: AssignmentRow,
): Promise<{ permissions: Record<string, PermissionMatrix>; navigation: NavigationNode[] }> {
  const superAdmin = isPlatformSuperAdmin(assignment);
  const [modules, roleAccessRows, overrideRows] = await Promise.all([
    moduleRepository.listActiveOrdered(),
    superAdmin ? Promise.resolve([]) : roleModuleAccessRepository.listByRoleId(assignment.role_id),
    superAdmin ? Promise.resolve([]) : userModuleAccessRepository.listActiveByUserRole(assignment.id),
  ]);

  const roleAccessByModuleId = new Map(roleAccessRows.map((row) => [row.module_id, row]));
  const overrideByModuleId = new Map(overrideRows.map((row) => [row.module_id, row]));

  // Feature gates (see FEATURE_GATES) turn gated actions false, so the map states what the API allows and a gated
  // `view` takes the module out of the menu. Platform staff (no organization) have no gates here.
  const permissions: Record<string, PermissionMatrix> = {};
  for (const module of modules) {
    if (!module.is_permission) continue;
    if (superAdmin) {
      permissions[module.code] = { ...FULL_PERMISSION };
      continue;
    }
    const matrix = effectivePermission(roleAccessByModuleId.get(module.id), overrideByModuleId.get(module.id));
    for (const action of gatedActions(module.code, assignment.organization)) matrix[action] = false;
    permissions[module.code] = matrix;
  }

  return { permissions, navigation: buildNavigationTree(modules, permissions) };
}

export const permissionResolutionService = { resolvePermission, resolveStaffSession };
