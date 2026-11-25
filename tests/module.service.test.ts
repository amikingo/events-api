import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { Transaction } from "sequelize";
import { NotFoundError } from "../src/errors/app-errors.js";
import { moduleRepository } from "../src/repositories/module.repository.js";
import { transactionManager } from "../src/services/helpers.js";
import { moduleService } from "../src/services/module.service.js";
import { IDS, moduleRow } from "./helpers/fixtures.js";

/** Modules (Phase 2d): the Super Admin's tree, and display-only edits. Mocked repository, fake transaction. */
const FAKE_TX = { id: "fake-transaction" } as unknown as Transaction;

beforeEach(() => {
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
});
afterEach(() => mock.restoreAll());

test("modules come back as a tree in menu order, switched-off ones included", async () => {
  mock.method(moduleRepository, "listAllOrdered", async () => [
    moduleRow({ id: "events-container", code: "EVENT_MANAGEMENT", parent_id: null, is_permission: false, sno: 5 }),
    moduleRow({ id: "admin-container", code: "ADMINISTRATION", parent_id: null, is_permission: false, sno: 10 }),
    moduleRow({ id: "events", code: "EVENTS", parent_id: "events-container", sno: 1 }),
    moduleRow({ id: "branches", code: "BRANCHES", parent_id: "admin-container", sno: 2, is_active: false }),
  ]);
  const tree = await moduleService.listModuleTree();
  assert.deepEqual(tree.map((node) => [node.code, node.children.map((child) => child.code)]), [
    ["EVENT_MANAGEMENT", ["EVENTS"]],
    ["ADMINISTRATION", ["BRANCHES"]],
  ]);
  assert.equal(tree[1]?.children[0]?.is_active, false);
});

test("an edit writes only the display fields it was given, with the module locked; an unknown module is 404", async () => {
  const find = mock.method(moduleRepository, "findById", async (_id: string, _options?: unknown) => moduleRow({ id: "events", code: "EVENTS" }));
  const update = mock.method(moduleRepository, "updateDisplay", async (_id: string, _values: Record<string, unknown>, _options?: unknown) =>
    moduleRow({ id: "events", code: "EVENTS", module_name: "Programs", sno: 3 }),
  );

  const node = await moduleService.updateModule("events", { module_name: "Programs", sno: 3, description: undefined, icon: undefined }, IDS.user);

  assert.deepEqual(find.mock.calls[0]?.arguments[1], { transaction: FAKE_TX, lock: true });
  assert.deepEqual(update.mock.calls[0]?.arguments[1], { module_name: "Programs", sno: 3, updated_by: IDS.user });
  assert.deepEqual([node.code, node.module_name, node.sno], ["EVENTS", "Programs", 3], "the code never changes");

  find.mock.mockImplementation(async () => null);
  await assert.rejects(moduleService.updateModule("nope", { sno: 1, description: undefined }, IDS.user), NotFoundError);
});
