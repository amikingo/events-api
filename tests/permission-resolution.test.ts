import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { InvalidScopeError } from "../src/errors/app-errors.js";
import type { RoleModuleAccessRow } from "../src/models/role-module-access.js";
import type { UserModuleAccessRow } from "../src/models/user-module-access.js";
import { branchRepository } from "../src/repositories/branch.repository.js";
import { moduleRepository } from "../src/repositories/module.repository.js";
import { roleModuleAccessRepository } from "../src/repositories/role-module-access.repository.js";
import { userModuleAccessRepository } from "../src/repositories/user-module-access.repository.js";
import { userRoleRepository, type AssignmentRow } from "../src/repositories/user-role.repository.js";
import {
  buildNavigationTree,
  permissionResolutionService,
  type PermissionScope,
} from "../src/services/permission-resolution.service.js";
import { DENIED_PERMISSION, type PermissionAction } from "../src/utils/rbac.js";
import { assignment, branchRow, IDS, moduleRow, platformSuperAdmin, roleRow } from "./helpers/fixtures.js";

const ORG_SCOPE = { level: "organization", organizationId: IDS.orgA, branchId: null } as const;
const ORG_B_SCOPE = { level: "organization", organizationId: IDS.orgB, branchId: null } as const;

// The existing tests below pass assignmentId: null (the internal "combine all roles" path).
// HTTP requests always resolve for one signed-in assignment; see resolveAs() and the tests at the end.

function grant(roleId: string, flags: Partial<RoleModuleAccessRow> = {}): RoleModuleAccessRow {
  return {
    id: crypto.randomUUID(),
    role_id: roleId,
    module_id: IDS.module,
    can_view: false,
    can_create: false,
    can_update: false,
    can_delete: false,
    can_import: false,
    can_export: false,
    can_notify: false,
    created_at: new Date(),
    updated_at: new Date(),
    created_by: null,
    updated_by: null,
    ...flags,
  };
}

function override(userRoleId: string, flags: Partial<UserModuleAccessRow>): UserModuleAccessRow {
  return {
    id: crypto.randomUUID(),
    user_role_id: userRoleId,
    module_id: IDS.module,
    can_view: null,
    can_create: null,
    can_update: null,
    can_delete: null,
    can_import: null,
    can_export: null,
    can_notify: null,
    is_active: true,
    created_at: new Date(),
    updated_at: new Date(),
    created_by: null,
    updated_by: null,
    ...flags,
  };
}

function arrange(input: { assignments: AssignmentRow[]; grants?: RoleModuleAccessRow[]; overrides?: UserModuleAccessRow[] }) {
  mock.method(userRoleRepository, "listActiveAssignmentsByUser", async () => input.assignments);
  mock.method(roleModuleAccessRepository, "listByRoleIdsAndModule", async (roleIds: readonly string[]) =>
    (input.grants ?? []).filter((row) => roleIds.includes(row.role_id)),
  );
  mock.method(userModuleAccessRepository, "listActiveByUserRoleIdsAndModule", async (ids: readonly string[]) =>
    (input.overrides ?? []).filter((row) => ids.includes(row.user_role_id)),
  );
}

beforeEach(() => {
  mock.method(moduleRepository, "findActivePermissionByCode", async () => moduleRow());
  mock.method(branchRepository, "findByOrganizationAndId", async (orgId: string, branchId: string) =>
    orgId === IDS.orgA ? branchRow({ id: branchId }) : null,
  );
});
afterEach(() => mock.restoreAll());

test("a tenant role grant never satisfies a platform-scoped check (privilege escalation guard)", async () => {
  arrange({ assignments: [assignment()], grants: [grant(IDS.roleA, { can_create: true })] });

  const result = await permissionResolutionService.resolvePermission({
    userId: IDS.user,
    assignmentId: null,
    scope: { level: "platform" },
    moduleCode: "ORGANIZATIONS",
    action: "create",
  });

  assert.equal(result.allowed, false);
  assert.equal(result.source, "no_assignment");
});

test("tenant role grants apply inside their own organization only", async () => {
  arrange({ assignments: [assignment()], grants: [grant(IDS.roleA, { can_view: true })] });

  const own = await permissionResolutionService.resolvePermission({ userId: IDS.user, assignmentId: null, scope: ORG_SCOPE, moduleCode: "BRANCHES", action: "view" });
  const other = await permissionResolutionService.resolvePermission({
    userId: IDS.user,
    assignmentId: null,
    scope: { level: "organization", organizationId: IDS.orgB, branchId: null },
    moduleCode: "BRANCHES",
    action: "view",
  });

  assert.deepEqual([own.allowed, own.source], [true, "role_permission"]);
  assert.deepEqual([other.allowed, other.source], [false, "no_assignment"]);
});

test("platform super admin bypasses role checks in any tenant", async () => {
  arrange({ assignments: [platformSuperAdmin()] });

  const result = await permissionResolutionService.resolvePermission({
    userId: IDS.user,
    assignmentId: null,
    scope: { level: "organization", organizationId: IDS.orgB, branchId: null },
    moduleCode: "BRANCHES",
    action: "delete",
  });

  assert.deepEqual([result.allowed, result.source], [true, "super_admin_bypass"]);
});

test("a branch-specific override beats an organization-wide role grant", async () => {
  const orgWide = assignment();
  const branchScoped = assignment({ id: "66666666-6666-4666-8666-666666666662", branch_id: IDS.branchA1, branch: branchRow() });
  arrange({
    assignments: [orgWide, branchScoped],
    grants: [grant(IDS.roleA, { can_view: true })],
    overrides: [override(branchScoped.id, { can_view: false })],
  });

  const result = await permissionResolutionService.resolvePermission({
    userId: IDS.user,
    assignmentId: null,
    scope: { level: "organization", organizationId: IDS.orgA, branchId: IDS.branchA1 },
    moduleCode: "BRANCHES",
    action: "view",
  });

  assert.deepEqual([result.allowed, result.source], [false, "user_override_deny"]);
});

test("conflicting overrides at the same specificity: deny wins", async () => {
  const first = assignment();
  const secondRoleId = "55555555-5555-4555-8555-555555555552";
  const second = assignment({
    id: "66666666-6666-4666-8666-666666666663",
    role_id: secondRoleId,
    role: roleRow({ id: secondRoleId, code: "SUPERVISOR", name: "Supervisor" }),
  });
  arrange({
    assignments: [first, second],
    overrides: [override(first.id, { can_update: true }), override(second.id, { can_update: false })],
  });

  const result = await permissionResolutionService.resolvePermission({ userId: IDS.user, assignmentId: null, scope: ORG_SCOPE, moduleCode: "BRANCHES", action: "update" });

  assert.equal(result.allowed, false);
});

test("a branch-scoped assignment cannot act organization-wide", async () => {
  arrange({
    assignments: [assignment({ branch_id: IDS.branchA1, branch: branchRow() })],
    grants: [grant(IDS.roleA, { can_view: true })],
  });

  const result = await permissionResolutionService.resolvePermission({ userId: IDS.user, assignmentId: null, scope: ORG_SCOPE, moduleCode: "BRANCHES", action: "view" });

  assert.equal(result.source, "no_assignment");
});

test("unknown or inactive modules are denied, and foreign branches are rejected", async () => {
  arrange({ assignments: [assignment()] });
  mock.method(moduleRepository, "findActivePermissionByCode", async () => null);
  const missing = await permissionResolutionService.resolvePermission({ userId: IDS.user, assignmentId: null, scope: ORG_SCOPE, moduleCode: "NOPE", action: "view" });
  assert.equal(missing.source, "module_unavailable");

  mock.method(moduleRepository, "findActivePermissionByCode", async () => moduleRow());
  await assert.rejects(
    permissionResolutionService.resolvePermission({
      userId: IDS.user,
      assignmentId: null,
      scope: { level: "organization", organizationId: IDS.orgB, branchId: IDS.branchA1 },
      moduleCode: "BRANCHES",
      action: "view",
    }),
    InvalidScopeError,
  );
});

// --- Signed-in assignment: the path every HTTP request takes ---------------------------------

const GATE_ROLE_ID = "55555555-5555-4555-8555-555555555553";

/** A second, weaker role in the same organization as the default MANAGER assignment. */
function gateStaffAssignment(): AssignmentRow {
  return assignment({
    id: "66666666-6666-4666-8666-666666666664",
    role_id: GATE_ROLE_ID,
    role: roleRow({ id: GATE_ROLE_ID, code: "GATE_STAFF", name: "Gate staff" }),
  });
}

/** Resolves the way requirePermission does: for one signed-in assignment. */
function resolveAs(assignmentId: string, action: PermissionAction, scope: PermissionScope = ORG_SCOPE, moduleCode = "BRANCHES") {
  return permissionResolutionService.resolvePermission({ userId: IDS.user, assignmentId, scope, moduleCode, action });
}

test("only the signed-in assignment counts: the weaker role is refused until the user switches", async () => {
  const gate = gateStaffAssignment();
  const manager = assignment();
  arrange({
    assignments: [gate, manager],
    grants: [grant(GATE_ROLE_ID, { can_view: true }), grant(IDS.roleA, { can_view: true, can_create: true })],
  });

  const asGate = await resolveAs(gate.id, "create");
  const asManager = await resolveAs(manager.id, "create");

  assert.deepEqual([asGate.allowed, asGate.source], [false, "default_deny"]);
  assert.deepEqual(asGate.roleIds, [GATE_ROLE_ID], "the manager role must not be consulted");
  assert.deepEqual([asManager.allowed, asManager.source], [true, "role_permission"]);
});

test("the signed-in assignment's override decides first; overrides on other assignments are ignored", async () => {
  const gate = gateStaffAssignment();
  const manager = assignment();
  arrange({
    assignments: [gate, manager],
    grants: [grant(IDS.roleA, { can_create: true })],
    overrides: [override(manager.id, { can_create: false }), override(gate.id, { can_update: true })],
  });

  const ownOverride = await resolveAs(manager.id, "create");
  const otherOverride = await resolveAs(manager.id, "update");
  const gateOwnOverride = await resolveAs(gate.id, "update");

  assert.deepEqual([ownOverride.allowed, ownOverride.source], [false, "user_override_deny"]);
  assert.deepEqual([otherOverride.allowed, otherOverride.source], [false, "default_deny"]);
  assert.deepEqual([gateOwnOverride.allowed, gateOwnOverride.source], [true, "user_override_allow"]);
});

test("a platform super admin signed in as super admin passes everywhere", async () => {
  const superAdmin = platformSuperAdmin();
  arrange({ assignments: [superAdmin] });

  const inTenant = await resolveAs(superAdmin.id, "delete", ORG_B_SCOPE);
  const onPlatform = await resolveAs(superAdmin.id, "create", { level: "platform" }, "ORGANIZATIONS");

  assert.deepEqual([inTenant.allowed, inTenant.source], [true, "super_admin_bypass"]);
  assert.deepEqual([onPlatform.allowed, onPlatform.source], [true, "super_admin_bypass"]);
});

test("holding super admin gives no bypass while signed in as another assignment", async () => {
  const superAdmin = platformSuperAdmin();
  // Realistic case: a second platform role (the database allows several platform roles per user).
  const supportRoleId = "55555555-5555-4555-8555-555555555558";
  const platformSupport = assignment({
    id: "66666666-6666-4666-8666-666666666667",
    role_id: supportRoleId,
    organization_id: null,
    organization: null,
    role: roleRow({ id: supportRoleId, organization_id: null, code: "SUPPORT", name: "Support" }),
  });
  // Defensive case: a tenant role next to super admin. The scope-guard trigger forbids this mix,
  // but the resolver must not depend on that.
  const tenantRole = assignment();
  arrange({ assignments: [superAdmin, platformSupport, tenantRole] });

  const asSupport = await resolveAs(platformSupport.id, "delete", ORG_B_SCOPE);
  const asTenantRole = await resolveAs(tenantRole.id, "delete");

  assert.deepEqual([asSupport.allowed, asSupport.source], [false, "default_deny"]);
  assert.deepEqual([asTenantRole.allowed, asTenantRole.source], [false, "default_deny"]);
});

test("a signed-in assignment that is unusable, not the user's, or outside the scope is denied", async () => {
  const manager = assignment();
  const inactiveRole = assignment({ id: "66666666-6666-4666-8666-666666666665", role: roleRow({ is_active: false }) });
  arrange({ assignments: [manager, inactiveRole], grants: [grant(IDS.roleA, { can_view: true })] });

  const cases: Array<[string, string, PermissionScope]> = [
    ["inactive role", inactiveRole.id, ORG_SCOPE],
    ["not one of the user's assignments", "66666666-6666-4666-8666-666666666660", ORG_SCOPE],
    ["another organization", manager.id, ORG_B_SCOPE],
  ];
  for (const [label, assignmentId, scope] of cases) {
    const result = await resolveAs(assignmentId, "view", scope);
    assert.deepEqual([result.allowed, result.source], [false, "no_assignment"], label);
  }
});

test("navigation keeps containers only when a child is visible, ordered by sno", () => {
  const container = moduleRow({ id: "c0000000-0000-4000-8000-000000000001", code: "ADMIN", module_name: "Admin", is_permission: false, route_name: null, sno: 1 });
  const emptyContainer = moduleRow({ id: "c0000000-0000-4000-8000-000000000002", code: "EMPTY", module_name: "Empty", is_permission: false, route_name: null, sno: 2 });
  const branches = moduleRow({ id: "a0000000-0000-4000-8000-000000000001", code: "BRANCHES", parent_id: container.id, sno: 2 });
  const roles = moduleRow({ id: "a0000000-0000-4000-8000-000000000002", code: "ROLES", module_name: "Roles", parent_id: container.id, sno: 1 });
  const hidden = moduleRow({ id: "a0000000-0000-4000-8000-000000000003", code: "MODULES", parent_id: emptyContainer.id });

  const tree = buildNavigationTree([container, emptyContainer, branches, roles, hidden], {
    BRANCHES: { ...DENIED_PERMISSION, view: true },
    ROLES: { ...DENIED_PERMISSION, view: true },
    MODULES: { ...DENIED_PERMISSION },
  });

  assert.deepEqual(
    tree.map((node) => [node.code, node.children.map((child) => child.code)]),
    [["ADMIN", ["ROLES", "BRANCHES"]]],
  );
});
