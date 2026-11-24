import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sequelize } from "../../src/db.js";
import { ConflictError } from "../../src/errors/app-errors.js";
import { normalizeError } from "../../src/middleware/error-handler.js";
import { migrator } from "../../src/migrator.js";
import { Branch, Role, RoleModuleAccess, UserRole } from "../../src/models/index.js";
import { branchRepository } from "../../src/repositories/branch.repository.js";
import { moduleRepository } from "../../src/repositories/module.repository.js";
import { authService } from "../../src/services/auth.service.js";
import { branchService } from "../../src/services/branch.service.js";
import { organizationService } from "../../src/services/organization.service.js";
import { permissionResolutionService } from "../../src/services/permission-resolution.service.js";
import { platformBootstrapService } from "../../src/services/platform-bootstrap.service.js";
import { MODULE_CODES } from "../../src/utils/module-codes.js";

/**
 * Runs against a real, disposable PostgreSQL database: TEST_DATABASE=1 plus POSTGRES_* env.
 * Proves the migrations, constraints, triggers, repositories, transactions and RBAC together,
 * then reverts every migration (which also proves each down()).
 */
const enabled = process.env.TEST_DATABASE === "1";
const skip = enabled ? false : "set TEST_DATABASE=1 with a disposable Postgres to run";

const USER = "a1111111-1111-4111-8111-111111111111";
const ADMIN = "a2222222-2222-4222-8222-222222222222";

async function expectConflict(work: Promise<unknown>): Promise<ConflictError> {
  try {
    await work;
  } catch (error) {
    const normalized = normalizeError(error);
    assert.ok(normalized instanceof ConflictError, `expected a conflict, got ${normalized.code}`);
    return normalized;
  }
  assert.fail("expected the database to reject the write");
}

before(async () => {
  if (!enabled) return;
  await migrator.down({ to: 0 });
  await migrator.up();
});

after(async () => {
  if (enabled) {
    // Seed down() refuses to delete reference rows that are still referenced (FK RESTRICT) -- by design.
    await sequelize.query(
      'TRUNCATE "user_module_access", "user_role", "role_module_access", "branch", "organization" CASCADE',
    );
    await migrator.down({ to: 0 });
  }
  await sequelize.close();
});

test("migrations seed every module code the code base references", { skip }, async () => {
  for (const code of Object.values(MODULE_CODES)) {
    assert.ok(await moduleRepository.findActivePermissionByCode(code), `module ${code} is not seeded`);
  }
});

test("tenant isolation, constraints, RBAC and the staff session work end to end", { skip }, async () => {
  const { organization: orgA, branches } = await organizationService.createOrganization(
    { organization: { name: "Org A", description: undefined } },
    ADMIN,
  );
  const { organization: orgB, branches: branchesB } = await organizationService.createOrganization(
    { organization: { name: "Org B", slug: "org-b", description: null }, default_branch: { code: "HQ", name: "HQ" } },
    ADMIN,
  );
  assert.equal(orgA.slug, "org-a");
  assert.equal(branches[0]?.is_default, true);

  // Service-level invariant first, database constraint as the backstop.
  await assert.rejects(branchService.createBranch(orgA.id, { code: "MAIN", name: "Dup", description: undefined }, ADMIN), ConflictError);
  const unique = await expectConflict(branchRepository.create({ organization_id: orgA.id, code: "MAIN", name: "Dup", description: null, created_by: null, updated_by: null }));
  assert.deepEqual(unique.details, { fields: ["organization_id", "code"] });

  // Composite FK: an org-A assignment can never point at an org-B branch.
  const roleA = await Role.create({ organization_id: orgA.id, code: "MANAGER", name: "Manager", description: null, created_by: null, updated_by: null });
  await expectConflict(
    UserRole.create({ user_id: USER, role_id: roleA.id, organization_id: orgA.id, branch_id: branchesB[0]?.id ?? null, created_by: null, updated_by: null }),
  );

  // Scope-guard trigger: a tenant role cannot be assigned in another organization.
  await assert.rejects(
    UserRole.create({ user_id: USER, role_id: roleA.id, organization_id: orgB.id, branch_id: null, created_by: null, updated_by: null }),
    (error) => normalizeError(error).code === "validation_error",
  );

  // Grant BRANCHES:view (and, maliciously, ORGANIZATIONS:create) to the tenant role.
  const branchesModule = await moduleRepository.findActivePermissionByCode("BRANCHES");
  const organizationsModule = await moduleRepository.findActivePermissionByCode("ORGANIZATIONS");
  assert.ok(branchesModule && organizationsModule);
  await RoleModuleAccess.create({ role_id: roleA.id, module_id: branchesModule.id, can_view: true, created_by: null, updated_by: null });
  await RoleModuleAccess.create({ role_id: roleA.id, module_id: organizationsModule.id, can_create: true, created_by: null, updated_by: null });
  const assignment = await UserRole.create({ user_id: USER, role_id: roleA.id, organization_id: orgA.id, branch_id: null, created_by: null, updated_by: null });

  const own = await permissionResolutionService.resolvePermission({
    userId: USER,
    assignmentId: assignment.id,
    scope: { level: "organization", organizationId: orgA.id, branchId: null },
    moduleCode: "BRANCHES",
    action: "view",
  });
  assert.deepEqual([own.allowed, own.source], [true, "role_permission"]);

  const escalation = await permissionResolutionService.resolvePermission({
    userId: USER,
    assignmentId: assignment.id,
    scope: { level: "platform" },
    moduleCode: "ORGANIZATIONS",
    action: "create",
  });
  assert.equal(escalation.allowed, false, "a tenant role must never satisfy a platform-scoped check");

  // Staff session hydration: flat permissions + nested navigation from the seeded catalogue.
  const session = await authService.getCurrentStaffSession({
    kind: "staff",
    userId: USER,
    assignmentId: assignment.id,
    roleId: roleA.id,
    organizationId: orgA.id,
    branchId: null,
    profile: { mobile: null, firstname: null, middlename: null, lastname: null },
    expiresAt: Math.floor(Date.now() / 1000) + 600,
  });
  assert.equal(session.permissions.BRANCHES?.view, true);
  assert.equal(session.permissions.MODULES?.view, false);
  const administration = session.navigation.find((node) => node.code === "ADMINISTRATION");
  assert.ok(administration?.children.some((child) => child.code === "BRANCHES"));
  assert.ok(!session.navigation.some((node) => node.code === "ACCESS_CONTROL"), "containers without visible children are hidden");

  assert.equal(await Branch.count(), 2);
});

test("super-admin bootstrap is previewable, idempotent and bypasses tenant checks", { skip }, async () => {
  const preview = await platformBootstrapService.assignSuperAdmin(ADMIN, { apply: false });
  assert.deepEqual([preview.action, preview.applied], ["create", false]);

  const applied = await platformBootstrapService.assignSuperAdmin(ADMIN, { apply: true });
  assert.deepEqual([applied.action, applied.applied], ["create", true]);

  const again = await platformBootstrapService.assignSuperAdmin(ADMIN, { apply: true });
  assert.equal(again.action, "unchanged");

  assert.ok(applied.assignmentId, "bootstrap returns the new assignment id");
  const anyTenant = await permissionResolutionService.resolvePermission({
    userId: ADMIN,
    assignmentId: applied.assignmentId,
    scope: { level: "organization", organizationId: "99999999-9999-4999-8999-999999999999", branchId: null },
    moduleCode: "BRANCHES",
    action: "delete",
  });
  assert.equal(anyTenant.source, "super_admin_bypass");
});
