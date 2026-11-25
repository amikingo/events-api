import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { Transaction } from "sequelize";
import { GrantExceedsOwnAccessError, OwnAssignmentError, OwnerNotOverridableError, ValidationAppError } from "../src/errors/app-errors.js";
import type { RoleModuleAccessRow } from "../src/models/role-module-access.js";
import type { UserModuleAccessRow } from "../src/models/user-module-access.js";
import { moduleRepository } from "../src/repositories/module.repository.js";
import { roleModuleAccessRepository } from "../src/repositories/role-module-access.repository.js";
import { roleRepository } from "../src/repositories/role.repository.js";
import { userModuleAccessRepository } from "../src/repositories/user-module-access.repository.js";
import { userRoleRepository } from "../src/repositories/user-role.repository.js";
import { transactionManager } from "../src/services/helpers.js";
import { permissionResolutionService, type PermissionScope } from "../src/services/permission-resolution.service.js";
import { staffAssignmentService } from "../src/services/staff-assignment.service.js";
import { assignment, IDS, moduleRow, roleRow } from "./helpers/fixtures.js";

/** Permission overrides (Phase 2d) against mocked repositories, the permission engine and a fake transaction. */
const FAKE_TX = { id: "fake-transaction" } as unknown as Transaction;
const EDITOR = { userId: IDS.user, assignmentId: IDS.assignment };
const STAFF_ID = "7d4b1f0e-2c3a-4e5f-8a9b-0c1d2e3f4a5b";
const VIEWER = roleRow({ id: "role-viewer", code: "VIEWER", name: "Viewer" });
const OWNER = roleRow({ id: "role-owner", code: "OWNER", name: "Owner" });
const MODULES = ["ORGANIZATIONS", "EVENTS", "REGISTRATIONS", "MODULES"].map((code) => moduleRow({ id: `module-${code}`, code, module_name: code }));

const grant = (moduleCode: string, flags: Partial<Record<"can_view" | "can_create" | "can_update" | "can_export", boolean>>) =>
  ({ role_id: VIEWER.id, module_id: `module-${moduleCode}`, can_view: false, can_create: false, can_update: false, can_export: false, ...flags }) as RoleModuleAccessRow;
const overrideRow = (moduleCode: string, flags: Partial<Record<"can_view" | "can_create" | "can_update" | "can_export", boolean | null>>) =>
  ({ user_role_id: "assignment-1", module_id: `module-${moduleCode}`, can_view: null, can_create: null, can_update: null, can_export: null, is_active: true, ...flags }) as UserModuleAccessRow;

type Arrange = { role?: typeof VIEWER; staffUserId?: string; overrides?: UserModuleAccessRow[]; allowed?: (moduleCode: string, action: string) => boolean };

function arrange(options: Arrange = {}) {
  const role = options.role ?? VIEWER;
  return {
    current: mock.method(userRoleRepository, "findByOrganizationAndId", async (_o: string, _id: string, _options?: unknown) =>
      assignment({ id: "assignment-1", user_id: options.staffUserId ?? STAFF_ID, role_id: role.id }),
    ),
    role: mock.method(roleRepository, "findByOrganizationAndId", async () => role),
    modules: mock.method(moduleRepository, "listActiveOrdered", async () => MODULES),
    grants: mock.method(roleModuleAccessRepository, "listByRoleId", async () => [grant("EVENTS", { can_view: true }), grant("REGISTRATIONS", { can_view: true, can_update: true })]),
    overrides: mock.method(userModuleAccessRepository, "listActiveByUserRole", async () => options.overrides ?? []),
    replace: mock.method(userModuleAccessRepository, "replaceForUserRole", async (_id: string, _rows: unknown[], _options: { transaction: Transaction }) => undefined),
    permission: mock.method(permissionResolutionService, "resolvePermission", async (input: { moduleCode: string; action: string; scope: PermissionScope }) => ({
      allowed: (options.allowed ?? (() => true))(input.moduleCode, input.action),
      source: "role_permission" as const,
      scope: input.scope,
      roleIds: [],
    })),
  };
}

beforeEach(() => {
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
});
afterEach(() => mock.restoreAll());

test("the list shows, per grantable module, what the role gives, the override and the effective result; platform modules never appear", async () => {
  arrange({ overrides: [overrideRow("EVENTS", { can_create: true }), overrideRow("REGISTRATIONS", { can_view: false })] });

  const result = await staffAssignmentService.listOverrides(IDS.orgA, "assignment-1");

  assert.equal(result.overridable, true);
  assert.deepEqual(result.modules.map((module) => module.module_code), ["ORGANIZATIONS", "EVENTS", "REGISTRATIONS"]);
  const events = result.modules.find((module) => module.module_code === "EVENTS");
  assert.deepEqual(events?.role, { view: true, create: false, update: false, export: false });
  assert.deepEqual(events?.override, { view: null, create: true, update: null, export: null });
  assert.deepEqual(events?.effective, { view: true, create: true, update: false, export: false });
  const guests = result.modules.find((module) => module.module_code === "REGISTRATIONS");
  assert.deepEqual(guests?.effective, { view: false, create: false, update: true, export: false }, "a deny wins over the role");
  assert.deepEqual(guests?.actions, ["view", "create", "update", "export"]);
});

test("an Owner's assignment is listed as not overridable", async () => {
  arrange({ role: OWNER });
  assert.equal((await staffAssignmentService.listOverrides(IDS.orgA, "assignment-1")).overridable, false);
});

test("saving replaces the whole set in one transaction with the assignment locked: allow, deny and null; an all-null module is removed", async () => {
  const fakes = arrange();

  await staffAssignmentService.replaceOverrides(
    IDS.orgA,
    "assignment-1",
    {
      overrides: [
        { module_code: "REGISTRATIONS", export: true, view: undefined, create: undefined, update: undefined },
        { module_code: "EVENTS", view: false, create: null, update: undefined, export: undefined },
        { module_code: "ORGANIZATIONS", view: null, create: null, update: null, export: null },
      ],
    },
    EDITOR,
  );

  assert.deepEqual(fakes.current.mock.calls[0]?.arguments[2], { transaction: FAKE_TX, lock: true });
  const [userRoleId, rows, options] = fakes.replace.mock.calls[0]?.arguments ?? [];
  assert.equal(userRoleId, "assignment-1");
  assert.equal(options?.transaction, FAKE_TX);
  const shaped = (rows as Array<Record<string, unknown>>).map((row) => [row.module_id, row.can_view, row.can_create, row.can_update, row.can_export, row.can_delete]);
  assert.deepEqual(shaped, [
    ["module-REGISTRATIONS", null, null, null, true, null],
    ["module-EVENTS", false, null, null, null, null],
  ]);
});

test("an Owner's assignment and your own are refused (409); nothing is written", async () => {
  const owner = arrange({ role: OWNER });
  await assert.rejects(staffAssignmentService.replaceOverrides(IDS.orgA, "assignment-1", { overrides: [] }, EDITOR), OwnerNotOverridableError);
  assert.equal(owner.replace.mock.callCount(), 0);
  mock.restoreAll();
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));

  const own = arrange({ staffUserId: IDS.user });
  await assert.rejects(staffAssignmentService.replaceOverrides(IDS.orgA, "assignment-1", { overrides: [] }, EDITOR), OwnAssignmentError);
  assert.equal(own.replace.mock.callCount(), 0);
});

test("platform modules and actions a tenant may not hold are 400, naming each, before the escalation check", async () => {
  const fakes = arrange({ allowed: () => false });
  await assert.rejects(
    staffAssignmentService.replaceOverrides(
      IDS.orgA,
      "assignment-1",
      {
        overrides: [
          { module_code: "MODULES", view: true, create: undefined, update: undefined, export: undefined },
          { module_code: "EVENTS", export: false, view: undefined, create: undefined, update: undefined },
        ],
      },
      EDITOR,
    ),
    (error: unknown) => {
      assert.ok(error instanceof ValidationAppError);
      const issues = (error.details as { issues: Array<{ path: string; code: string }> }).issues;
      assert.deepEqual(issues.map((issue) => [issue.path, issue.code]), [
        ["body.overrides.0.module_code", "module_not_grantable"],
        ["body.overrides.1.export", "action_not_grantable"],
      ]);
      return true;
    },
  );
  assert.equal(fakes.permission.mock.callCount(), 0);
});

test("allowing needs the editor to hold the action; denying, or keeping an existing allow, needs nothing", async () => {
  const fakes = arrange({
    overrides: [overrideRow("EVENTS", { can_create: true })],
    allowed: (moduleCode, action) => !(moduleCode === "REGISTRATIONS" && action === "export"),
  });

  await staffAssignmentService.replaceOverrides(
    IDS.orgA,
    "assignment-1",
    {
      overrides: [
        { module_code: "EVENTS", create: true, view: false, update: undefined, export: undefined },
        { module_code: "REGISTRATIONS", view: false, create: undefined, update: undefined, export: undefined },
      ],
    },
    EDITOR,
  );
  assert.equal(fakes.permission.mock.callCount(), 0, "kept allow and denies need no access of your own");

  await assert.rejects(
    staffAssignmentService.replaceOverrides(
      IDS.orgA,
      "assignment-1",
      { overrides: [{ module_code: "REGISTRATIONS", export: true, view: undefined, create: undefined, update: undefined }] },
      EDITOR,
    ),
    (error: unknown) => error instanceof GrantExceedsOwnAccessError && JSON.stringify(error.details) === JSON.stringify({ module_code: "REGISTRATIONS", action: "export" }),
  );
  const asked = fakes.permission.mock.calls.at(-1)?.arguments[0] as { assignmentId: string; scope: PermissionScope } | undefined;
  assert.deepEqual([asked?.assignmentId, asked?.scope], [IDS.assignment, { level: "organization", organizationId: IDS.orgA, branchId: null }]);
});
