import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { Transaction } from "sequelize";
import {
  ConflictError,
  InvalidModuleStateError,
  ModuleInUseError,
  ModuleProtectedError,
  NotFoundError,
  ValidationAppError,
} from "../src/errors/app-errors.js";
import type { ModuleRow } from "../src/models/module.js";
import { moduleRepository } from "../src/repositories/module.repository.js";
import { roleModuleAccessRepository } from "../src/repositories/role-module-access.repository.js";
import { roleTemplateRepository } from "../src/repositories/role-template.repository.js";
import { userModuleAccessRepository } from "../src/repositories/user-module-access.repository.js";
import { transactionManager } from "../src/services/helpers.js";
import { moduleService } from "../src/services/module.service.js";
import type { ModuleCreateInput, ModuleUpdateInput } from "../src/validators/module.js";
import { IDS, moduleRow } from "./helpers/fixtures.js";

/** Modules (Phase 2d, extended in Phase 2e): the tree, edits, creation and on/off. Mocked repository, fake transaction. */
const FAKE_TX = { id: "fake-transaction" } as unknown as Transaction;

const ADMIN = moduleRow({ id: "admin", code: "ADMINISTRATION", parent_id: null, is_permission: false, route_name: null, sno: 10 });
const REPORTS = moduleRow({ id: "reports", code: "REPORTS", parent_id: null, is_permission: false, route_name: null, sno: 30 });
const SALES = moduleRow({ id: "sales", code: "SALES_REPORT", parent_id: "reports", is_permission: true, route_name: "/reports/sales", sno: 1 });
const EVENTS = moduleRow({ id: "events", code: "EVENTS", parent_id: null, route_name: "/events" });
const ROLES = moduleRow({ id: "roles", code: "ROLES", parent_id: "admin", route_name: "/access/roles" });
const OLD = moduleRow({ id: "old", code: "OLD_GROUP", parent_id: null, is_permission: false, is_active: false });

let tree: ModuleRow[];

/** An edit as the validator hands it over (description is always present, undefined when left out). */
const edit = (fields: Partial<ModuleUpdateInput>): ModuleUpdateInput => ({ description: undefined, ...fields });

function arrangeTree(rows: ModuleRow[]) {
  tree = rows;
  mock.method(moduleRepository, "listAllOrdered", async () => tree);
  mock.method(moduleRepository, "findById", async (id: string) => tree.find((row) => row.id === id) ?? null);
}

function arrangeGrants(counts: { roles?: number; templates?: number; overrides?: number }) {
  mock.method(roleModuleAccessRepository, "countByModule", async () => counts.roles ?? 0);
  mock.method(roleTemplateRepository, "countGrantsByModule", async () => counts.templates ?? 0);
  mock.method(userModuleAccessRepository, "countByModule", async () => counts.overrides ?? 0);
}

const updates = () =>
  mock.method(moduleRepository, "updateById", async (id: string, values: Partial<ModuleRow>) => ({ ...(tree.find((row) => row.id === id) as ModuleRow), ...values }));

let lockTree: ReturnType<typeof mock.method>;

beforeEach(() => {
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
  lockTree = mock.method(moduleRepository, "lockTree", async () => undefined);
  arrangeTree([ADMIN, REPORTS, SALES, EVENTS, ROLES, OLD]);
  arrangeGrants({});
});
afterEach(() => mock.restoreAll());

test("modules come back as a tree in menu order, switched-off ones included, marked core and always-on", async () => {
  arrangeTree([
    moduleRow({ id: "events-container", code: "EVENT_MANAGEMENT", parent_id: null, is_permission: false, sno: 5 }),
    moduleRow({ id: "admin-container", code: "ADMINISTRATION", parent_id: null, is_permission: false, sno: 10 }),
    moduleRow({ id: "events", code: "EVENTS", parent_id: "events-container", sno: 1 }),
    moduleRow({ id: "branches", code: "BRANCHES", parent_id: "admin-container", sno: 2, is_active: false }),
    moduleRow({ id: "roles", code: "ROLES", parent_id: "admin-container", sno: 3 }),
  ]);
  const nodes = await moduleService.listModuleTree();
  assert.deepEqual(nodes.map((node) => [node.code, node.children.map((child) => child.code)]), [
    ["EVENT_MANAGEMENT", ["EVENTS"]],
    ["ADMINISTRATION", ["BRANCHES", "ROLES"]],
  ]);
  const [branches, roles] = nodes[1]?.children ?? [];
  assert.deepEqual([branches?.is_active, branches?.is_core, branches?.always_on], [false, true, false]);
  assert.deepEqual([roles?.is_core, roles?.always_on], [true, true]);
  assert.deepEqual([nodes[0]?.is_core, nodes[0]?.always_on], [false, false], "menu groups are not core");
});

test("an edit writes only the fields it was given, under the tree lock with the module locked; an unknown module is 404", async () => {
  const find = mock.method(moduleRepository, "findById", async (_id: string, _options?: unknown) => EVENTS);
  const update = updates();

  const node = await moduleService.updateModule("events", edit({ module_name: "Programs", sno: 3, description: undefined, icon: undefined }), IDS.user);

  assert.equal(lockTree.mock.callCount(), 1);
  assert.deepEqual(find.mock.calls[0]?.arguments[1], { transaction: FAKE_TX, lock: true });
  assert.deepEqual(update.mock.calls[0]?.arguments[1], { module_name: "Programs", sno: 3, updated_by: IDS.user });
  assert.deepEqual([node.code, node.module_name, node.sno], ["EVENTS", "Programs", 3], "the code never changes");

  find.mock.mockImplementation(async () => null);
  await assert.rejects(moduleService.updateModule("nope", edit({ sno: 1, description: undefined }), IDS.user), NotFoundError);
});

// --- Phase 2e step 6 ------------------------------------------------------------------------------------

const NEW_GROUP: ModuleCreateInput = { code: "INSIGHTS", module_name: "Insights", description: undefined, is_menu: true, is_permission: false };

test("creating a module: stored switched on with defaults; a taken code is 409; the parent must exist and be switched on", async () => {
  mock.method(moduleRepository, "findByCode", async (code: string) => tree.find((row) => row.code === code) ?? null);
  const create = mock.method(moduleRepository, "create", async (values: Partial<ModuleRow>) => moduleRow({ ...values, id: "new" }));

  const created = await moduleService.createModule({ ...NEW_GROUP, parent_id: "reports", route_name: "/insights" }, IDS.user);
  assert.equal(created.code, "INSIGHTS");
  assert.deepEqual(create.mock.calls[0]?.arguments[0], {
    code: "INSIGHTS",
    module_name: "Insights",
    description: null,
    parent_id: "reports",
    sno: 0,
    icon: null,
    route_name: "/insights",
    is_menu: true,
    is_permission: false,
    is_active: true,
    created_by: IDS.user,
    updated_by: IDS.user,
  });
  assert.equal(lockTree.mock.callCount(), 1);

  await assert.rejects(moduleService.createModule({ ...NEW_GROUP, code: "REPORTS" }, IDS.user), (error: unknown) => error instanceof ConflictError);
  const issueCode = (error: unknown) => (error as ValidationAppError & { details: { issues: Array<{ code: string }> } }).details.issues[0]?.code;
  await assert.rejects(moduleService.createModule({ ...NEW_GROUP, parent_id: "missing" }, IDS.user), (error: unknown) => issueCode(error) === "parent_not_found");
  await assert.rejects(moduleService.createModule({ ...NEW_GROUP, parent_id: "old" }, IDS.user), (error: unknown) => issueCode(error) === "parent_inactive");
  assert.equal(create.mock.callCount(), 1, "nothing written after a refusal");
});

test("moving a module: under itself or one of its submodules is 400 parent_cycle; elsewhere it moves", async () => {
  const update = updates();
  const issueCode = (error: unknown) => (error as { details: { issues: Array<{ code: string }> } }).details.issues[0]?.code;

  await assert.rejects(moduleService.updateModule("reports", edit({ parent_id: "reports" }), IDS.user), (error: unknown) => issueCode(error) === "parent_cycle");
  await assert.rejects(moduleService.updateModule("reports", edit({ parent_id: "sales" }), IDS.user), (error: unknown) => error instanceof ValidationAppError && issueCode(error) === "parent_cycle");
  assert.equal(update.mock.callCount(), 0);

  const moved = await moduleService.updateModule("events", edit({ parent_id: "reports" }), IDS.user);
  assert.equal(moved.parent_id, "reports");
  const top = await moduleService.updateModule("sales", edit({ parent_id: null }), IDS.user);
  assert.equal(top.parent_id, null, "null moves it to the top level");
});

test("core modules keep their route and permission flag (409 module_protected) but may move and change the menu flag", async () => {
  updates();
  await assert.rejects(moduleService.updateModule("events", edit({ route_name: "/programs" }), IDS.user), (error: unknown) => {
    return error instanceof ModuleProtectedError && (error.details as { field: string }).field === "route_name";
  });
  await assert.rejects(moduleService.updateModule("events", edit({ is_permission: false }), IDS.user), ModuleProtectedError);
  const same = await moduleService.updateModule("events", edit({ route_name: "/events", is_permission: true, is_menu: false, parent_id: "admin" }), IDS.user);
  assert.deepEqual([same.route_name, same.is_menu, same.parent_id], ["/events", false, "admin"], "sending the current values is fine");

  const custom = await moduleService.updateModule("sales", edit({ route_name: "/reports/sales-by-day" }), IDS.user);
  assert.equal(custom.route_name, "/reports/sales-by-day", "a module the API created may change its route");
});

test("a module stops being a permission module only when no role, template or override grants it (409 module_in_use)", async () => {
  const update = updates();
  arrangeGrants({ roles: 2, templates: 1, overrides: 0 });
  await assert.rejects(moduleService.updateModule("sales", edit({ is_permission: false }), IDS.user), (error: unknown) => {
    return error instanceof ModuleInUseError && (error.details as { grants: number }).grants === 3;
  });
  assert.equal(update.mock.callCount(), 0);

  arrangeGrants({});
  assert.equal((await moduleService.updateModule("sales", edit({ is_permission: false }), IDS.user)).is_permission, false);
  arrangeGrants({ roles: 5 });
  assert.equal((await moduleService.updateModule("reports", edit({ is_permission: true }), IDS.user)).is_permission, true, "becoming one needs no check");
});

test("switching off: always-on modules are refused; a module with switched-on submodules is refused; otherwise it switches", async () => {
  const update = updates();
  await assert.rejects(moduleService.changeModuleStatus("roles", false, IDS.user), ModuleProtectedError);
  await assert.rejects(moduleService.changeModuleStatus("reports", false, IDS.user), (error: unknown) => {
    return error instanceof InvalidModuleStateError && (error.details as { active_children: number }).active_children === 1;
  });
  assert.equal(update.mock.callCount(), 0);

  const off = await moduleService.changeModuleStatus("events", false, IDS.user);
  assert.equal(off.is_active, false);
  assert.deepEqual(update.mock.calls[0]?.arguments.slice(0, 2), ["events", { is_active: false, updated_by: IDS.user }]);
  assert.equal(lockTree.mock.callCount(), 3);
});

test("switching on: refused under a switched-off parent; the current state again writes nothing", async () => {
  const update = updates();
  arrangeTree([OLD, moduleRow({ id: "child", code: "OLD_CHILD", parent_id: "old", is_active: false }), EVENTS]);
  await assert.rejects(moduleService.changeModuleStatus("child", true, IDS.user), InvalidModuleStateError);
  assert.equal((await moduleService.changeModuleStatus("events", true, IDS.user)).is_active, true);
  assert.equal(update.mock.callCount(), 0);
  assert.equal((await moduleService.changeModuleStatus("old", true, IDS.user)).is_active, true);
  assert.equal(update.mock.callCount(), 1);
});
