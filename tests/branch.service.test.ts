import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { Transaction } from "sequelize";
import { ConflictError, InvalidBranchStateError } from "../src/errors/app-errors.js";
import { branchRepository } from "../src/repositories/branch.repository.js";
import { organizationRepository } from "../src/repositories/organization.repository.js";
import { branchService } from "../src/services/branch.service.js";
import { transactionManager } from "../src/services/helpers.js";
import { branchRow, IDS, organizationRow } from "./helpers/fixtures.js";

const FAKE_TX = { id: "fake-transaction" } as unknown as Transaction;

beforeEach(() => {
  // Services run their real transaction logic against a fake transaction: no database needed.
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
  mock.method(organizationRepository, "findById", async () => organizationRow());
});
afterEach(() => mock.restoreAll());

test("createBranch rejects a duplicate code within the tenant", async () => {
  mock.method(branchRepository, "findByOrganizationAndCode", async () => branchRow());
  const create = mock.method(branchRepository, "create", async () => branchRow());

  await assert.rejects(
    branchService.createBranch(IDS.orgA, { code: "MAIN", name: "Main", description: undefined }, null),
    ConflictError,
  );
  assert.equal(create.mock.callCount(), 0);
});

test("the first branch of a tenant becomes the default, inside the service transaction", async () => {
  mock.method(branchRepository, "findByOrganizationAndCode", async () => null);
  const findDefault = mock.method(branchRepository, "findActiveDefaultByOrganization", async () => null);
  const create = mock.method(branchRepository, "create", async () => branchRow());

  await branchService.createBranch(IDS.orgA, { code: "MAIN", name: "Main", description: undefined }, IDS.user);

  assert.deepEqual(findDefault.mock.calls[0]?.arguments, [IDS.orgA, { transaction: FAKE_TX, lock: true }]);
  const [values, options] = create.mock.calls[0]?.arguments ?? [];
  assert.equal(values?.is_default, true);
  assert.equal(values?.organization_id, IDS.orgA);
  assert.equal(values?.created_by, IDS.user);
  assert.deepEqual(options, { transaction: FAKE_TX });
});

test("updateBranch persists only allow-listed fields with PATCH semantics", async () => {
  mock.method(branchRepository, "findByOrganizationAndId", async () => branchRow());
  mock.method(branchRepository, "findByOrganizationAndCode", async () => null);
  const update = mock.method(branchRepository, "updateByOrganizationAndId", async () => branchRow());

  // name omitted (keep), description null (clear), code supplied (replace)
  await branchService.updateBranch(IDS.orgA, IDS.branchA1, { code: "NORTH", description: null }, IDS.user);

  const [orgId, branchId, values] = update.mock.calls[0]?.arguments ?? [];
  assert.equal(orgId, IDS.orgA);
  assert.equal(branchId, IDS.branchA1);
  assert.deepEqual(values, { code: "NORTH", description: null, updated_by: IDS.user });
});

test("the default branch cannot be deactivated", async () => {
  mock.method(branchRepository, "findByOrganizationAndId", async () => branchRow({ is_default: true }));
  await assert.rejects(branchService.changeBranchStatus(IDS.orgA, IDS.branchA1, false, null), InvalidBranchStateError);
});
