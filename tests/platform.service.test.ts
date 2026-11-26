import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { Transaction } from "sequelize";
import { centralAuthClient, type CentralUser } from "../src/clients/central-auth.client.js";
import {
  ConflictError,
  GrantExceedsOwnAccessError,
  LastSuperAdminError,
  OwnAssignmentError,
  RoleInUseError,
  RoleLockedError,
  ValidationAppError,
} from "../src/errors/app-errors.js";
import type { RoleRow } from "../src/models/role.js";
import type { UserRoleRow } from "../src/models/user-role.js";
import { moduleRepository } from "../src/repositories/module.repository.js";
import { roleModuleAccessRepository } from "../src/repositories/role-module-access.repository.js";
import { roleRepository } from "../src/repositories/role.repository.js";
import { userRoleRepository } from "../src/repositories/user-role.repository.js";
import { transactionManager } from "../src/services/helpers.js";
import { permissionResolutionService, type PermissionScope } from "../src/services/permission-resolution.service.js";
import { platformRoleService } from "../src/services/platform-role.service.js";
import { platformStaffService } from "../src/services/platform-staff.service.js";
import { assignment, IDS, moduleRow, roleRow } from "./helpers/fixtures.js";

/** Platform roles and platform staff (Phase 2e) against mocked repositories and a fake transaction: no database. */
const FAKE_TX = { id: "fake-transaction" } as unknown as Transaction;
const EDITOR = { userId: IDS.user, assignmentId: IDS.assignment };
const SUPER_ADMIN = roleRow({ id: "role-super", organization_id: null, code: "SUPER_ADMIN", name: "Super Admin" });
const SUPPORT = roleRow({ id: "role-support", organization_id: null, code: "PLATFORM_SUPPORT", name: "Platform support" });
const MODULES = ["ORGANIZATIONS", "REGISTRATIONS", "MODULES"].map((code) => moduleRow({ id: `module-${code}`, code, module_name: code }));
const PERSON_ID = "7d4b1f0e-2c3a-4e5f-8a9b-0c1d2e3f4a5b";
const PERSON: CentralUser = { userId: PERSON_ID, mobile: "+251911234567", firstname: "Hana", middlename: null, lastname: "Bekele" };
const grant = (module_code: string, view: boolean, update = false) => ({ module_code, view, create: false, update });

let allowed: (moduleCode: string, action: string) => boolean = () => true;

function arrangeRoles(roles: RoleRow[] = [SUPER_ADMIN, SUPPORT], holders = 0) {
  const list = [...roles];
  return {
    list: mock.method(roleRepository, "listPlatform", async () => list),
    byId: mock.method(roleRepository, "findPlatformById", async (id: string, _options?: unknown) => list.find((role) => role.id === id) ?? null),
    byCode: mock.method(roleRepository, "findPlatformRoleByCode", async (code: string) => list.find((role) => role.code === code) ?? null),
    create: mock.method(roleRepository, "create", async (values: Partial<RoleRow>, _options?: unknown) => {
      const created = roleRow({ ...values, id: "role-new" });
      list.push(created);
      return created;
    }),
    update: mock.method(roleRepository, "updatePlatformById", async (_id: string, _values: Record<string, unknown>, _options?: unknown) => null),
    grants: mock.method(roleModuleAccessRepository, "listWithModulesByRoleIds", async () => []),
    replace: mock.method(roleModuleAccessRepository, "replaceForRole", async (_id: string, _rows: unknown[], _options: { transaction: Transaction }) => undefined),
    members: mock.method(userRoleRepository, "countActivePlatformByRoles", async () => new Map<string, number>()),
    holders: mock.method(userRoleRepository, "countActivePlatformByRole", async () => holders),
    modules: mock.method(moduleRepository, "listActiveOrdered", async () => MODULES),
    permission: mock.method(permissionResolutionService, "resolvePermission", async (input: { moduleCode: string; action: string; scope: PermissionScope }) => ({
      allowed: allowed(input.moduleCode, input.action),
      source: "role_permission" as const,
      scope: input.scope,
      roleIds: [],
    })),
  };
}

beforeEach(() => {
  allowed = () => true;
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
});
afterEach(() => mock.restoreAll());

// --- Platform roles -----------------------------------------------------------------------------------------

test("a platform role may hold platform modules; it is stored with no organization; escalation is checked at platform scope", async () => {
  const fakes = arrangeRoles();
  await platformRoleService.createRole({ code: "PLATFORM_HELP", name: "Help", description: undefined, grants: [grant("MODULES", true), grant("REGISTRATIONS", true)] }, EDITOR);
  assert.equal(fakes.create.mock.calls[0]?.arguments[0]?.organization_id, null);
  const [roleId, rows] = fakes.replace.mock.calls[0]?.arguments ?? [];
  assert.equal(roleId, "role-new");
  assert.deepEqual((rows as Array<{ role_id: string; module_id: string }>).map((row) => [row.role_id, row.module_id]), [
    ["role-new", "module-MODULES"],
    ["role-new", "module-REGISTRATIONS"],
  ]);
  assert.deepEqual(fakes.permission.mock.calls[0]?.arguments[0].scope, { level: "platform" });
});

test("an unknown module is 400; granting what you don't hold at platform scope is 403; nothing is written", async () => {
  const fakes = arrangeRoles();
  await assert.rejects(
    platformRoleService.createRole({ code: "X", name: "X", description: undefined, grants: [grant("NOPE", true)] }, EDITOR),
    (error: unknown) => error instanceof ValidationAppError && JSON.stringify(error.details).includes("body.grants.0.module_code"),
  );
  allowed = (moduleCode) => moduleCode !== "MODULES";
  await assert.rejects(platformRoleService.createRole({ code: "Y", name: "Y", description: undefined, grants: [grant("MODULES", true)] }, EDITOR), GrantExceedsOwnAccessError);
  assert.equal(fakes.create.mock.callCount(), 0);
});

test("SUPER_ADMIN is locked; a platform role still held can't be switched off; codes are unique", async () => {
  arrangeRoles([SUPER_ADMIN, SUPPORT], 2);
  await assert.rejects(platformRoleService.updateRole(SUPER_ADMIN.id, { name: "Boss", description: undefined }, EDITOR), RoleLockedError);
  await assert.rejects(platformRoleService.changeRoleStatus(SUPER_ADMIN.id, false, EDITOR), RoleLockedError);
  await assert.rejects(platformRoleService.changeRoleStatus(SUPPORT.id, false, EDITOR), RoleInUseError);
  await assert.rejects(platformRoleService.createRole({ code: "PLATFORM_SUPPORT", name: "Other", description: undefined, grants: [] }, EDITOR), ConflictError);
});

// --- Platform staff ------------------------------------------------------------------------------------------

function arrangeStaff(options: { current?: UserRoleRow; superAdmins?: number; elsewhere?: UserRoleRow[] } = {}) {
  arrangeRoles();
  const current = options.current ?? assignment({ id: "platform-1", user_id: PERSON_ID, role_id: SUPPORT.id, organization_id: null });
  return {
    lookUp: mock.method(centralAuthClient, "findUserByMobile", async () => PERSON),
    names: mock.method(centralAuthClient, "getUsersByIds", async () => [PERSON]),
    lockUser: mock.method(userRoleRepository, "lockAssignmentsOfUser", async () => undefined),
    lockSupers: mock.method(userRoleRepository, "lockSuperAdmins", async () => undefined),
    allOfUser: mock.method(userRoleRepository, "listAllByUser", async () => options.elsewhere ?? []),
    findByScope: mock.method(userRoleRepository, "findByScope", async () => null),
    create: mock.method(userRoleRepository, "create", async (_values: Partial<UserRoleRow>, _options?: unknown) => assignment({ id: "platform-new", organization_id: null })),
    current: mock.method(userRoleRepository, "findPlatformById", async () => current),
    superAdmins: mock.method(userRoleRepository, "countActivePlatformByRole", async () => options.superAdmins ?? 2),
    setActive: mock.method(userRoleRepository, "setActive", async () => undefined),
    updateRole: mock.method(userRoleRepository, "updateRoleAndBranch", async () => undefined),
    destroy: mock.method(userRoleRepository, "deletePlatformById", async () => undefined),
    staff: mock.method(userRoleRepository, "findPlatformStaffById", async () => ({ ...current, role: SUPPORT, branch: null })),
  };
}

test("a platform role is given with no organization or branch; someone who is staff of an organization is refused", async () => {
  const fakes = arrangeStaff();
  const { outcome } = await platformStaffService.assign({ mobile: "+251911234567", role_id: SUPPORT.id }, IDS.user);
  assert.equal(outcome, "CREATED");
  const [values] = fakes.create.mock.calls[0]?.arguments ?? [];
  assert.deepEqual([values?.organization_id, values?.branch_id, values?.role_id, values?.user_id], [null, null, SUPPORT.id, PERSON_ID]);
  mock.restoreAll();
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));

  arrangeStaff({ elsewhere: [assignment({ organization_id: IDS.orgA, is_active: false })] });
  await assert.rejects(platformStaffService.assign({ mobile: "+251911234567", role_id: SUPPORT.id }, IDS.user), (error: unknown) => {
    assert.ok(error instanceof ConflictError);
    assert.deepEqual(error.details, { field: "user_id" });
    return true;
  });
});

test("the last active Super Admin can't be moved, switched off or deleted; nobody changes their own platform assignment", async () => {
  const lastSuper = assignment({ id: "platform-super", user_id: PERSON_ID, role_id: SUPER_ADMIN.id, organization_id: null });
  const fakes = arrangeStaff({ current: lastSuper, superAdmins: 1 });
  await assert.rejects(platformStaffService.update("platform-super", SUPPORT.id, IDS.user), LastSuperAdminError);
  await assert.rejects(platformStaffService.changeStatus("platform-super", false, IDS.user), LastSuperAdminError);
  await assert.rejects(platformStaffService.remove("platform-super", IDS.user), LastSuperAdminError);
  await assert.rejects(platformStaffService.remove("platform-super", PERSON_ID), OwnAssignmentError);
  assert.equal(fakes.destroy.mock.callCount(), 0);
  assert.ok(fakes.lockSupers.mock.callCount() >= 3, "under the Super Admin lock");

  mock.restoreAll();
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
  const two = arrangeStaff({ current: lastSuper, superAdmins: 2 });
  await platformStaffService.remove("platform-super", IDS.user);
  assert.equal(two.destroy.mock.callCount(), 1, "with another Super Admin it can go");
});
