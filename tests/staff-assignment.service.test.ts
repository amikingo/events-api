import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { Transaction } from "sequelize";
import { centralAuthClient, type CentralUser } from "../src/clients/central-auth.client.js";
import {
  CentralAccountNotFoundError,
  CentralAuthUnavailableError,
  AssignmentScopeConflictError,
  ConflictError,
  InvalidBranchStateError,
  LastOwnerAssignmentError,
  NotFoundError,
  OwnAssignmentError,
  RoleInactiveError,
} from "../src/errors/app-errors.js";
import type { RoleRow } from "../src/models/role.js";
import type { UserRoleRow } from "../src/models/user-role.js";
import { branchRepository } from "../src/repositories/branch.repository.js";
import { organizationRepository } from "../src/repositories/organization.repository.js";
import { roleRepository } from "../src/repositories/role.repository.js";
import { userModuleAccessRepository } from "../src/repositories/user-module-access.repository.js";
import { userRoleRepository } from "../src/repositories/user-role.repository.js";
import { transactionManager } from "../src/services/helpers.js";
import { staffAssignmentService } from "../src/services/staff-assignment.service.js";
import { assignment, branchRow, IDS, organizationRow, roleRow } from "./helpers/fixtures.js";

/** Staff management against mocked repositories, auth-cheche and a fake transaction: no database, no network. */
const FAKE_TX = { id: "fake-transaction" } as unknown as Transaction;
const PERSON_ID = "7d4b1f0e-2c3a-4e5f-8a9b-0c1d2e3f4a5b";
const PERSON: CentralUser = { userId: PERSON_ID, mobile: "+251911234567", firstname: "Hana", middlename: null, lastname: "Bekele" };
const VIEWER = roleRow({ id: "role-viewer", code: "VIEWER", name: "Viewer" });
const OWNER = roleRow({ id: "role-owner", code: "OWNER", name: "Owner" });

let order: string[] = [];

type Arrange = {
  person?: CentralUser | null;
  roles?: RoleRow[];
  elsewhere?: UserRoleRow[];
  existing?: UserRoleRow | null;
  current?: UserRoleRow | null;
  owners?: number;
  hasBranches?: boolean;
};

function arrange(options: Arrange = {}) {
  const roles = options.roles ?? [VIEWER, OWNER];
  const current = options.current === undefined ? assignment({ id: "assignment-1", user_id: PERSON_ID, role_id: OWNER.id }) : options.current;
  return {
    lookUp: mock.method(centralAuthClient, "findUserByMobile", async () => {
      order.push("lookup");
      return options.person === undefined ? PERSON : options.person;
    }),
    names: mock.method(centralAuthClient, "getUsersByIds", async () => [PERSON]),
    lockUser: mock.method(userRoleRepository, "lockAssignmentsOfUser", async () => undefined),
    lockOwners: mock.method(userRoleRepository, "lockOwnersOfOrganization", async () => undefined),
    organization: mock.method(organizationRepository, "findById", async () => organizationRow({ has_branches: options.hasBranches ?? true })),
    role: mock.method(roleRepository, "findByOrganizationAndId", async (_o: string, roleId: string) => roles.find((role) => role.id === roleId) ?? null),
    branch: mock.method(branchRepository, "findByOrganizationAndId", async () => branchRow()),
    allOfUser: mock.method(userRoleRepository, "listAllByUser", async () => options.elsewhere ?? []),
    findByScope: mock.method(userRoleRepository, "findByScope", async () => options.existing ?? null),
    create: mock.method(userRoleRepository, "create", async (_values: Partial<UserRoleRow>, _options?: unknown) => assignment({ id: "assignment-new" })),
    setActive: mock.method(userRoleRepository, "setActive", async () => undefined),
    current: mock.method(userRoleRepository, "findByOrganizationAndId", async () => current),
    owners: mock.method(userRoleRepository, "countActiveOwners", async () => options.owners ?? 2),
    updateRole: mock.method(userRoleRepository, "updateRoleAndBranch", async () => undefined),
    overrideCount: mock.method(userModuleAccessRepository, "countActiveByUserRole", async () => 0),
    staff: mock.method(userRoleRepository, "findStaffByOrganizationAndId", async () => ({
      ...assignment({ id: "assignment-1", user_id: PERSON_ID }),
      role: VIEWER,
      branch: null,
    })),
  };
}

beforeEach(() => {
  order = [];
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => {
    order.push("transaction");
    return work(FAKE_TX);
  });
});
afterEach(() => mock.restoreAll());

// --- Look up and assign ---------------------------------------------------------------------------

test("a lookup shows who uses the mobile; no account is 404 central_account_not_found", async () => {
  arrange();
  assert.deepEqual(await staffAssignmentService.lookUp("+251911234567"), {
    user_id: PERSON_ID,
    firstname: "Hana",
    middlename: null,
    lastname: "Bekele",
    mobile: "+251911234567",
  });
  mock.restoreAll();
  arrange({ person: null });
  await assert.rejects(staffAssignmentService.lookUp("+251911000000"), CentralAccountNotFoundError);
});

test("assigning looks the mobile up first, outside the transaction, then creates the assignment for that account", async () => {
  const calls = arrange();

  const { outcome, assignment: dto } = await staffAssignmentService.assign(IDS.orgA, { mobile: "+251911234567", role_id: VIEWER.id }, IDS.user);

  assert.equal(outcome, "CREATED");
  assert.deepEqual(order, ["lookup", "transaction"], "no database lock is held while waiting on Central Auth");
  const [values, options] = calls.create.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(values, { user_id: PERSON_ID, role_id: VIEWER.id, organization_id: IDS.orgA, branch_id: null, created_by: IDS.user, updated_by: IDS.user });
  assert.deepEqual(options, { transaction: FAKE_TX });
  assert.equal(calls.lockUser.mock.callCount(), 1, "the person's assignments are locked (one organization rule)");
  assert.deepEqual(dto.profile, { firstname: "Hana", middlename: null, lastname: "Bekele", mobile: "+251911234567" });
});

test("an unknown account, a role of another organization or the platform, and an inactive role are refused before any write", async () => {
  const noAccount = arrange({ person: null });
  await assert.rejects(staffAssignmentService.assign(IDS.orgA, { mobile: "+251911000000", role_id: VIEWER.id }, IDS.user), CentralAccountNotFoundError);
  assert.deepEqual(order, ["lookup"], "no transaction at all");
  assert.equal(noAccount.create.mock.callCount(), 0);
  mock.restoreAll();
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));

  const foreign = arrange();
  await assert.rejects(
    staffAssignmentService.assign(IDS.orgA, { mobile: "+251911234567", role_id: "super-admin-or-other-organization" }, IDS.user),
    NotFoundError,
  );
  assert.equal(foreign.create.mock.callCount(), 0);
  mock.restoreAll();
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));

  arrange({ roles: [roleRow({ id: "role-old", code: "OLD", is_active: false })] });
  await assert.rejects(staffAssignmentService.assign(IDS.orgA, { mobile: "+251911234567", role_id: "role-old" }, IDS.user), RoleInactiveError);
});

test("someone already in another organization is refused; a branch needs an organization with branches", async () => {
  arrange({ elsewhere: [assignment({ organization_id: IDS.orgB })] });
  await assert.rejects(staffAssignmentService.assign(IDS.orgA, { mobile: "+251911234567", role_id: VIEWER.id }, IDS.user), ConflictError);
  mock.restoreAll();
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));

  const calls = arrange({ hasBranches: false });
  await assert.rejects(
    staffAssignmentService.assign(IDS.orgA, { mobile: "+251911234567", role_id: VIEWER.id, branch_id: IDS.branchA1 }, IDS.user),
    InvalidBranchStateError,
  );
  assert.equal(calls.create.mock.callCount(), 0);
});

test("the same role again is unchanged; an inactive identical assignment is reactivated", async () => {
  const same = arrange({ existing: assignment({ id: "assignment-1", is_active: true }) });
  assert.equal((await staffAssignmentService.assign(IDS.orgA, { mobile: "+251911234567", role_id: VIEWER.id }, IDS.user)).outcome, "UNCHANGED");
  assert.deepEqual([same.create.mock.callCount(), same.setActive.mock.callCount()], [0, 0]);
  mock.restoreAll();
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));

  const back = arrange({ existing: assignment({ id: "assignment-1", is_active: false }) });
  assert.equal((await staffAssignmentService.assign(IDS.orgA, { mobile: "+251911234567", role_id: VIEWER.id }, IDS.user)).outcome, "REACTIVATED");
  assert.deepEqual(back.setActive.mock.calls[0]?.arguments.slice(0, 2), ["assignment-1", true]);
});

// --- The last Owner -------------------------------------------------------------------------------

test("the last active Owner can't be deactivated or moved to another role; with another Owner it can", async () => {
  const last = arrange({ owners: 1 });
  await assert.rejects(staffAssignmentService.changeStatus(IDS.orgA, "assignment-1", false, IDS.user), LastOwnerAssignmentError);
  await assert.rejects(staffAssignmentService.update(IDS.orgA, "assignment-1", { role_id: VIEWER.id }, IDS.user), LastOwnerAssignmentError);
  assert.deepEqual([last.setActive.mock.callCount(), last.updateRole.mock.callCount()], [0, 0]);
  assert.ok(last.lockOwners.mock.callCount() >= 2, "Owner changes are serialized per organization");
  mock.restoreAll();
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));

  const two = arrange({ owners: 2 });
  await staffAssignmentService.changeStatus(IDS.orgA, "assignment-1", false, IDS.user);
  await staffAssignmentService.update(IDS.orgA, "assignment-1", { role_id: VIEWER.id }, IDS.user);
  assert.deepEqual(two.setActive.mock.calls[0]?.arguments.slice(0, 2), ["assignment-1", false]);
  const [, values] = two.updateRole.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(values, { role_id: VIEWER.id, branch_id: null, updated_by: IDS.user });
});

test("a non-Owner can be moved or deactivated freely; null branch_id makes it organization-wide; asking for the current state changes nothing", async () => {
  const calls = arrange({ owners: 1, current: assignment({ id: "assignment-1", role_id: VIEWER.id, branch_id: IDS.branchA1 }) });
  await staffAssignmentService.update(IDS.orgA, "assignment-1", { branch_id: null }, IDS.user);
  assert.deepEqual(calls.updateRole.mock.calls[0]?.arguments[1], { role_id: VIEWER.id, branch_id: null, updated_by: IDS.user });
  await staffAssignmentService.changeStatus(IDS.orgA, "assignment-1", true, IDS.user);
  assert.equal(calls.setActive.mock.callCount(), 0, "already active");
  assert.equal(calls.owners.mock.callCount(), 0, "no Owner check for a Viewer");
});

// --- Names ----------------------------------------------------------------------------------------

test("the staff list carries names from Central Auth, and still answers with profile null when Central Auth fails", async () => {
  const calls = arrange();
  mock.method(userRoleRepository, "listByOrganization", async () => ({
    rows: [{ ...assignment({ id: "assignment-1", user_id: PERSON_ID }), role: VIEWER, branch: null }],
    count: 1,
  }));
  const named = await staffAssignmentService.list(IDS.orgA, { page: 1, pageSize: 20, is_active: undefined });
  assert.deepEqual([named.count, named.rows[0]?.profile?.firstname, named.rows[0]?.role.code], [1, "Hana", "VIEWER"]);
  assert.deepEqual(calls.names.mock.calls[0]?.arguments, [[PERSON_ID]]);

  calls.names.mock.mockImplementation(async () => {
    throw new CentralAuthUnavailableError();
  });
  const unnamed = await staffAssignmentService.list(IDS.orgA, { page: 1, pageSize: 20, is_active: undefined });
  assert.deepEqual([unnamed.count, unnamed.rows[0]?.profile], [1, null], "assignments are never hidden because names failed");
});

// --- Phase 2d: overrides stay when the role changes, and the reply says how many --------------------------------

test("changing the role reports how many permission overrides the person still has; changing only the branch doesn't count as a role change", async () => {
  const fakes = arrange({ current: assignment({ id: "assignment-1", user_id: PERSON_ID, role_id: VIEWER.id }), roles: [VIEWER, OWNER] });
  fakes.overrideCount.mock.mockImplementation(async () => 2);

  const changed = await staffAssignmentService.update(IDS.orgA, "assignment-1", { role_id: OWNER.id, branch_id: undefined }, IDS.user);
  assert.deepEqual([changed.role_changed, changed.override_count], [true, 2]);

  const same = await staffAssignmentService.update(IDS.orgA, "assignment-1", { role_id: VIEWER.id, branch_id: undefined }, IDS.user);
  assert.equal(same.role_changed, false);
});

// --- Phase 2e step 1: one assignment, filters, and no overlap between org-wide and branch -----------------------

test("one assignment is read with the person's name; the list passes the role and branch filters through", async () => {
  const fakes = arrange();
  const list = mock.method(userRoleRepository, "listByOrganization", async (_o: string, _filters: unknown) => ({ rows: [], count: 0 }));

  const one = await staffAssignmentService.get(IDS.orgA, "assignment-1");
  assert.equal(one.profile?.firstname, "Hana");
  assert.deepEqual(fakes.staff.mock.calls[0]?.arguments.slice(0, 2), [IDS.orgA, "assignment-1"]);

  await staffAssignmentService.list(IDS.orgA, { page: 1, pageSize: 20, is_active: true, role_id: VIEWER.id, branch_id: IDS.branchA1 });
  assert.deepEqual(list.mock.calls[0]?.arguments[1], { isActive: true, roleId: VIEWER.id, branchId: IDS.branchA1, limit: 20, offset: 0 });
});

test("the same role can't be held organization-wide and on a branch at once; several branches are fine", async () => {
  const onBranch = assignment({ id: "held-branch", user_id: PERSON_ID, role_id: VIEWER.id, branch_id: IDS.branchA1 });
  const orgWide = assignment({ id: "held-org", user_id: PERSON_ID, role_id: VIEWER.id, branch_id: null });

  arrange({ elsewhere: [onBranch] });
  await assert.rejects(staffAssignmentService.assign(IDS.orgA, { mobile: PERSON.mobile as string, role_id: VIEWER.id }, IDS.user), AssignmentScopeConflictError);
  mock.restoreAll();
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));

  arrange({ elsewhere: [orgWide] });
  await assert.rejects(
    staffAssignmentService.assign(IDS.orgA, { mobile: PERSON.mobile as string, role_id: VIEWER.id, branch_id: IDS.branchA2 }, IDS.user),
    AssignmentScopeConflictError,
  );
  mock.restoreAll();
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));

  const fakes = arrange({ elsewhere: [onBranch] });
  await staffAssignmentService.assign(IDS.orgA, { mobile: PERSON.mobile as string, role_id: VIEWER.id, branch_id: IDS.branchA2 }, IDS.user);
  assert.equal(fakes.create.mock.callCount(), 1, "another branch is fine");
});

test("moving an assignment, or switching it back on, into an overlap is refused", async () => {
  const onBranch = assignment({ id: "held-branch", user_id: PERSON_ID, role_id: VIEWER.id, branch_id: IDS.branchA1 });
  const current = assignment({ id: "assignment-1", user_id: PERSON_ID, role_id: VIEWER.id, branch_id: IDS.branchA2 });
  const fakes = arrange({ current, elsewhere: [onBranch, current] });
  await assert.rejects(staffAssignmentService.update(IDS.orgA, "assignment-1", { branch_id: null }, IDS.user), AssignmentScopeConflictError);
  assert.equal(fakes.updateRole.mock.callCount(), 0);
  assert.equal(fakes.lockUser.mock.callCount(), 1, "the person's assignments are locked while checking");
  mock.restoreAll();
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));

  const switchedOff = assignment({ id: "assignment-1", user_id: PERSON_ID, role_id: VIEWER.id, branch_id: null, is_active: false });
  const reactivate = arrange({ current: switchedOff, elsewhere: [onBranch, switchedOff] });
  await assert.rejects(staffAssignmentService.changeStatus(IDS.orgA, "assignment-1", true, IDS.user), AssignmentScopeConflictError);
  assert.equal(reactivate.setActive.mock.callCount(), 0);
});

// --- Phase 2e step 2: deleting an assignment -------------------------------------------------------------

test("an assignment is deleted for good under the Owner lock; the last active Owner and your own can't be", async () => {
  const fakes = arrange({ current: assignment({ id: "assignment-1", user_id: PERSON_ID, role_id: VIEWER.id }) });
  const destroy = mock.method(userRoleRepository, "deleteByOrganizationAndId", async (_o: string, _id: string, _options: { transaction: Transaction }) => undefined);

  await staffAssignmentService.remove(IDS.orgA, "assignment-1", IDS.user);
  assert.deepEqual(destroy.mock.calls[0]?.arguments, [IDS.orgA, "assignment-1", { transaction: FAKE_TX }]);
  assert.equal(fakes.lockOwners.mock.callCount(), 1);
  mock.restoreAll();
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));

  arrange({ current: assignment({ id: "assignment-1", user_id: PERSON_ID, role_id: OWNER.id }), owners: 1 });
  const refused = mock.method(userRoleRepository, "deleteByOrganizationAndId", async () => undefined);
  await assert.rejects(staffAssignmentService.remove(IDS.orgA, "assignment-1", IDS.user), LastOwnerAssignmentError);
  await assert.rejects(staffAssignmentService.remove(IDS.orgA, "assignment-1", PERSON_ID), OwnAssignmentError);
  assert.equal(refused.mock.callCount(), 0);
});
