import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { CreationAttributes, Transaction } from "sequelize";
import { ConflictError, NotFoundError } from "../src/errors/app-errors.js";
import type { BranchRow } from "../src/models/branch.js";
import type { Role, RoleRow } from "../src/models/role.js";
import type { UserRoleRow } from "../src/models/user-role.js";
import { branchRepository } from "../src/repositories/branch.repository.js";
import { moduleRepository } from "../src/repositories/module.repository.js";
import { organizationRepository } from "../src/repositories/organization.repository.js";
import { roleModuleAccessRepository } from "../src/repositories/role-module-access.repository.js";
import { roleRepository } from "../src/repositories/role.repository.js";
import { userRoleRepository } from "../src/repositories/user-role.repository.js";
import { transactionManager } from "../src/services/helpers.js";
import { organizationProvisioningService } from "../src/services/organization-provisioning.service.js";
import { assignment, branchRow, IDS, moduleRow, organizationRow, platformSuperAdmin, roleRow } from "./helpers/fixtures.js";

/** The provisioning service against mocked repositories and a fake transaction: no database needed. */
const FAKE_TX = { id: "fake-transaction" } as unknown as Transaction;
const NEW_ORG = organizationRow({ id: IDS.orgB, name: "Selam Events", slug: "selam-events" });
const MODULES = [
  moduleRow({ id: "module-administration", code: "ADMINISTRATION", is_permission: false }),
  moduleRow({ id: "module-organizations", code: "ORGANIZATIONS" }),
  moduleRow({ id: "module-branches", code: "BRANCHES" }),
  moduleRow({ id: "module-roles", code: "ROLES" }),
  moduleRow({ id: "module-user-roles", code: "USER_ROLES" }),
];
const flags = (grant: { can_view?: boolean; can_create?: boolean; can_update?: boolean; can_delete?: boolean; can_import?: boolean; can_export?: boolean; can_notify?: boolean } | undefined) => [
  grant?.can_view,
  grant?.can_create,
  grant?.can_update,
  grant?.can_delete,
  grant?.can_import,
  grant?.can_export,
  grant?.can_notify,
];

beforeEach(() => {
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
  mock.method(userRoleRepository, "lockAssignmentsOfUser", async () => undefined);
});
afterEach(() => mock.restoreAll());

// --- provisionOrganizer ---------------------------------------------------------------------------

function arrangeProvisioning(options: { slugTaken?: boolean; existingAssignments?: UserRoleRow[] } = {}) {
  mock.method(organizationRepository, "findBySlug", async () => (options.slugTaken ? organizationRow() : null));
  mock.method(userRoleRepository, "listAllByUser", async () => options.existingAssignments ?? []);
  mock.method(moduleRepository, "listActiveOrdered", async () => MODULES);
  return {
    createOrganization: mock.method(organizationRepository, "create", async () => NEW_ORG),
    createBranch: mock.method(branchRepository, "create", async () => branchRow({ organization_id: NEW_ORG.id })),
    createRole: mock.method(roleRepository, "create", async (values: CreationAttributes<Role>) =>
      roleRow({ id: `role-${values.code}`, organization_id: NEW_ORG.id, code: values.code, name: values.name }),
    ),
    bulkCreate: mock.method(roleModuleAccessRepository, "bulkCreate", async () => undefined),
    createAssignment: mock.method(userRoleRepository, "create", async () => assignment({ id: "assignment-owner" })),
  };
}

test("provisionOrganizer writes the organization, MAIN branch, default roles with grants and the owner's assignment in one transaction", async () => {
  const calls = arrangeProvisioning();

  const result = await organizationProvisioningService.provisionOrganizer({ name: "Selam Events", ownerUserId: IDS.user }, null, {
    apply: true,
  });

  assert.equal(result.applied, true);
  assert.equal(result.slug, "selam-events");
  assert.equal(result.organizationId, NEW_ORG.id);
  assert.equal(result.ownerAssignmentId, "assignment-owner");
  assert.deepEqual(result.roleIds, { OWNER: "role-OWNER", VIEWER: "role-VIEWER" });

  assert.deepEqual(
    calls.createRole.mock.calls.map((call) => [call.arguments[0].code, call.arguments[0].organization_id]),
    [
      ["OWNER", NEW_ORG.id],
      ["VIEWER", NEW_ORG.id],
    ],
  );
  const [ownerGrants = []] = calls.bulkCreate.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(
    ownerGrants.map((grant) => grant.module_id),
    ["module-organizations", "module-branches", "module-roles", "module-user-roles"],
    "only permission modules, never the container",
  );
  assert.deepEqual(flags(ownerGrants.find((grant) => grant.module_id === "module-branches")), [true, true, true, false, false, false, false]);
  assert.deepEqual(flags(ownerGrants.find((grant) => grant.module_id === "module-organizations")), [true, false, true, false, false, false, false]);
  const [viewerGrants = []] = calls.bulkCreate.mock.calls[1]?.arguments ?? [];
  assert.deepEqual(
    viewerGrants.map((grant) => [grant.module_id, ...flags(grant)]),
    [
      ["module-organizations", true, false, false, false, false, false, false],
      ["module-branches", true, false, false, false, false, false, false],
    ],
  );

  const [owner] = calls.createAssignment.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(
    [owner?.user_id, owner?.role_id, owner?.organization_id, owner?.branch_id],
    [IDS.user, "role-OWNER", NEW_ORG.id, null],
    "the owner is assigned organization-wide",
  );

  const writes = [
    ...calls.createOrganization.mock.calls,
    ...calls.createBranch.mock.calls,
    ...calls.createRole.mock.calls,
    ...calls.bulkCreate.mock.calls,
    ...calls.createAssignment.mock.calls,
  ];
  assert.equal(writes.length, 7);
  for (const call of writes) assert.deepEqual(call.arguments.at(-1), { transaction: FAKE_TX }, "every write joins the one transaction");
});

test("provisionOrganizer preview checks everything and writes nothing", async () => {
  const calls = arrangeProvisioning();

  const result = await organizationProvisioningService.provisionOrganizer({ name: "Selam Events", ownerUserId: IDS.user }, null, {
    apply: false,
  });

  assert.deepEqual(result, {
    applied: false,
    slug: "selam-events",
    organizationId: null,
    defaultBranchId: null,
    roleIds: {},
    ownerAssignmentId: null,
  });
  for (const write of Object.values(calls)) assert.equal(write.mock.callCount(), 0);
});

test("an owner who already has any assignment, even an inactive one, is refused before anything is written", async () => {
  const calls = arrangeProvisioning({ existingAssignments: [assignment({ organization_id: IDS.orgA, is_active: false })] });

  await assert.rejects(
    organizationProvisioningService.provisionOrganizer({ name: "Selam Events", ownerUserId: IDS.user }, null, { apply: true }),
    ConflictError,
  );
  assert.equal(calls.createOrganization.mock.callCount(), 0);
});

test("a slug that is already used is refused", async () => {
  const calls = arrangeProvisioning({ slugTaken: true });

  await assert.rejects(
    organizationProvisioningService.provisionOrganizer({ name: "Selam Events", ownerUserId: IDS.user }, null, { apply: true }),
    (error: unknown) => error instanceof ConflictError && (error.details as { field: string }).field === "slug",
  );
  assert.equal(calls.createOrganization.mock.callCount(), 0);
});

// --- assignStaff ----------------------------------------------------------------------------------

const ADDIS = branchRow({ id: IDS.branchA2, code: "ADDIS", is_default: false });
const ASSIGN_TO_ADDIS = { organizationId: IDS.orgA, userId: IDS.user, roleCode: "viewer", branchCode: "addis" };

function arrangeAssignment(
  options: { role?: RoleRow | null; branch?: BranchRow | null; existing?: UserRoleRow | null; assignments?: UserRoleRow[] } = {},
) {
  mock.method(organizationRepository, "findById", async () => organizationRow());
  mock.method(userRoleRepository, "listAllByUser", async () => options.assignments ?? []);
  return {
    findRole: mock.method(roleRepository, "findByOrganizationAndCode", async () =>
      options.role === undefined ? roleRow({ code: "VIEWER" }) : options.role,
    ),
    findBranch: mock.method(branchRepository, "findByOrganizationAndCode", async () =>
      options.branch === undefined ? ADDIS : options.branch,
    ),
    findByScope: mock.method(userRoleRepository, "findByScope", async () => options.existing ?? null),
    create: mock.method(userRoleRepository, "create", async () => assignment({ id: "assignment-new" })),
    setActive: mock.method(userRoleRepository, "setActive", async () => undefined),
  };
}

test("assignStaff creates a branch assignment with normalised codes; other roles in the same organization are fine", async () => {
  const calls = arrangeAssignment({ assignments: [assignment({ organization_id: IDS.orgA, role_id: "another-role" })] });

  const result = await organizationProvisioningService.assignStaff(ASSIGN_TO_ADDIS, IDS.user, { apply: true });

  assert.deepEqual(result, { action: "create", applied: true, assignmentId: "assignment-new", branchId: IDS.branchA2 });
  assert.deepEqual(calls.findRole.mock.calls[0]?.arguments, [IDS.orgA, "VIEWER", { transaction: FAKE_TX }]);
  assert.deepEqual(calls.findBranch.mock.calls[0]?.arguments, [IDS.orgA, "ADDIS", { transaction: FAKE_TX }]);
  const [values, options] = calls.create.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(
    [values?.user_id, values?.role_id, values?.organization_id, values?.branch_id, values?.created_by],
    [IDS.user, IDS.roleA, IDS.orgA, IDS.branchA2, IDS.user],
  );
  assert.deepEqual(options, { transaction: FAKE_TX });
});

test("assignStaff refuses a role that does not exist in the organization", async () => {
  const calls = arrangeAssignment({ role: null });
  await assert.rejects(organizationProvisioningService.assignStaff(ASSIGN_TO_ADDIS, null, { apply: true }), NotFoundError);
  assert.equal(calls.create.mock.callCount(), 0);
});

test("assignStaff refuses a branch that does not exist in the organization", async () => {
  const calls = arrangeAssignment({ branch: null });
  await assert.rejects(organizationProvisioningService.assignStaff(ASSIGN_TO_ADDIS, null, { apply: true }), NotFoundError);
  assert.equal(calls.create.mock.callCount(), 0);
});

test("assignStaff refuses someone with an assignment in another organization, even an inactive one", async () => {
  const calls = arrangeAssignment({ assignments: [assignment({ organization_id: IDS.orgB, is_active: false })] });
  await assert.rejects(organizationProvisioningService.assignStaff(ASSIGN_TO_ADDIS, null, { apply: true }), ConflictError);
  assert.equal(calls.create.mock.callCount(), 0);
});

test("assignStaff refuses platform staff", async () => {
  const calls = arrangeAssignment({ assignments: [platformSuperAdmin()] });
  await assert.rejects(organizationProvisioningService.assignStaff(ASSIGN_TO_ADDIS, null, { apply: true }), ConflictError);
  assert.equal(calls.create.mock.callCount(), 0);
});

test("an identical active assignment is left unchanged and nothing is written", async () => {
  const calls = arrangeAssignment({ existing: assignment({ id: "assignment-old", is_active: true }) });

  const result = await organizationProvisioningService.assignStaff(ASSIGN_TO_ADDIS, null, { apply: true });

  assert.deepEqual(result, { action: "unchanged", applied: false, assignmentId: "assignment-old", branchId: IDS.branchA2 });
  assert.equal(calls.create.mock.callCount() + calls.setActive.mock.callCount(), 0);
});

test("an identical inactive assignment is reactivated instead of duplicated", async () => {
  const calls = arrangeAssignment({ existing: assignment({ id: "assignment-old", is_active: false }) });

  const result = await organizationProvisioningService.assignStaff(ASSIGN_TO_ADDIS, IDS.user, { apply: true });

  assert.deepEqual(result, { action: "reactivate", applied: true, assignmentId: "assignment-old", branchId: IDS.branchA2 });
  assert.deepEqual(calls.setActive.mock.calls[0]?.arguments, ["assignment-old", true, IDS.user, { transaction: FAKE_TX }]);
  assert.equal(calls.create.mock.callCount(), 0);
});

test("assignStaff preview reports the action and writes nothing", async () => {
  const calls = arrangeAssignment();

  const result = await organizationProvisioningService.assignStaff(ASSIGN_TO_ADDIS, null, { apply: false });

  assert.deepEqual(result, { action: "create", applied: false, assignmentId: null, branchId: IDS.branchA2 });
  assert.equal(calls.create.mock.callCount() + calls.setActive.mock.callCount(), 0);
});
