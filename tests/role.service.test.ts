import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { Transaction } from "sequelize";
import { ConflictError, GrantExceedsOwnAccessError, RoleInUseError, RoleLockedError, ValidationAppError } from "../src/errors/app-errors.js";
import type { RoleRow } from "../src/models/role.js";
import { moduleRepository } from "../src/repositories/module.repository.js";
import { organizationRepository } from "../src/repositories/organization.repository.js";
import { roleModuleAccessRepository, type RoleGrantRow } from "../src/repositories/role-module-access.repository.js";
import { roleRepository } from "../src/repositories/role.repository.js";
import { userRoleRepository } from "../src/repositories/user-role.repository.js";
import { transactionManager } from "../src/services/helpers.js";
import { permissionResolutionService, type PermissionScope } from "../src/services/permission-resolution.service.js";
import { roleService, type RoleEditor } from "../src/services/role.service.js";
import { DEFAULT_TENANT_ROLES } from "../src/utils/default-roles.js";
import { TENANT_GRANTABLE } from "../src/utils/rbac.js";
import type { RoleGrantInput } from "../src/validators/role.js";
import { IDS, moduleRow, organizationRow, roleRow } from "./helpers/fixtures.js";

/** Custom roles (Phase 2c) against mocked repositories, the permission engine and a fake transaction: no database. */
const FAKE_TX = { id: "fake-transaction" } as unknown as Transaction;
const EDITOR: RoleEditor = { userId: IDS.user, assignmentId: IDS.assignment };
const OWNER = roleRow({ id: "role-owner", code: "OWNER", name: "Owner" });
const VIEWER = roleRow({ id: "role-viewer", code: "VIEWER", name: "Viewer" });
const DOOR = roleRow({ id: "role-door", code: "DOOR_STAFF", name: "Door staff" });
const MODULES = ["ORGANIZATIONS", "BRANCHES", "ROLES", "USER_ROLES", "EVENTS", "CUSTOMERS", "REGISTRATIONS", "MODULES", "ROLE_TEMPLATES"].map(
  (code) => moduleRow({ id: `module-${code}`, code, module_name: code }),
);

type Box = "view" | "create" | "update" | "delete" | "import" | "export" | "notify";
const grant = (module_code: string, actions: Partial<Record<Box, boolean>>): RoleGrantInput => ({
  module_code,
  view: actions.view ?? false,
  create: actions.create ?? false,
  update: actions.update ?? false,
  ...(actions.delete === undefined ? {} : { delete: actions.delete }),
  ...(actions.import === undefined ? {} : { import: actions.import }),
  ...(actions.export === undefined ? {} : { export: actions.export }),
  ...(actions.notify === undefined ? {} : { notify: actions.notify }),
});

function storedGrant(roleId: string, moduleCode: string, flags: { view?: boolean; create?: boolean; update?: boolean; export?: boolean }): RoleGrantRow {
  return {
    role_id: roleId,
    module_id: `module-${moduleCode}`,
    can_view: flags.view ?? false,
    can_create: flags.create ?? false,
    can_update: flags.update ?? false,
    can_delete: false,
    can_import: false,
    can_export: flags.export ?? false,
    can_notify: false,
    module: { code: moduleCode, module_name: moduleCode, sno: 1 },
  } as unknown as RoleGrantRow;
}

type Arrange = { roles?: RoleRow[]; stored?: RoleGrantRow[]; allowed?: (moduleCode: string, action: string) => boolean; holders?: number };

let order: string[] = [];

function arrange(options: Arrange = {}) {
  const roles = [...(options.roles ?? [OWNER, VIEWER, DOOR])];
  const allowed = options.allowed ?? (() => true);
  return {
    organization: mock.method(organizationRepository, "findById", async () => organizationRow()),
    byCode: mock.method(roleRepository, "findByOrganizationAndCode", async (_o: string, code: string) => roles.find((role) => role.code === code) ?? null),
    byId: mock.method(roleRepository, "findByOrganizationAndId", async (_o: string, roleId: string, _options?: unknown) => roles.find((role) => role.id === roleId) ?? null),
    list: mock.method(roleRepository, "listByOrganization", async () => roles),
    create: mock.method(roleRepository, "create", async (values: Partial<RoleRow>, _options?: unknown) => {
      order.push("create");
      const created = roleRow({ ...values, id: "role-new" });
      roles.push(created); // read back by the service after its grants are stored
      return created;
    }),
    update: mock.method(roleRepository, "updateByOrganizationAndId", async (_o: string, _id: string, _values: Record<string, unknown>, _options?: unknown) => {
      order.push("update");
      return null;
    }),
    modules: mock.method(moduleRepository, "listActiveOrdered", async () => MODULES),
    stored: mock.method(roleModuleAccessRepository, "listWithModulesByRoleIds", async () => options.stored ?? []),
    replace: mock.method(roleModuleAccessRepository, "replaceForRole", async (_roleId: string, _rows: unknown[], _options: { transaction: Transaction }) => {
      order.push("replace");
    }),
    holders: mock.method(userRoleRepository, "countActiveByRole", async () => options.holders ?? 0),
    members: mock.method(userRoleRepository, "countActiveByRoles", async () => new Map<string, number>()),
    permission: mock.method(
      permissionResolutionService,
      "resolvePermission",
      async (input: { moduleCode: string; action: string; scope: PermissionScope; userId: string; assignmentId?: string | null }) => ({
        allowed: allowed(input.moduleCode, input.action),
        source: "role_permission" as const,
        scope: input.scope,
        roleIds: [],
      }),
    ),
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

test("creating a role stores it with its grants in one transaction; a box left out is stored as false", async () => {
  const fakes = arrange();
  await roleService.createRole(
    IDS.orgA,
    { code: "GATE", name: "Gate", description: "At the door", grants: [grant("REGISTRATIONS", { view: true, update: true }), grant("EVENTS", {})] },
    EDITOR,
  );

  assert.deepEqual(order, ["transaction", "create", "replace"]);
  const [roleId, rows, options] = fakes.replace.mock.calls[0]?.arguments ?? [];
  assert.equal(roleId, "role-new");
  assert.equal(options?.transaction, FAKE_TX);
  assert.deepEqual(rows, [
    {
      role_id: "role-new",
      module_id: "module-REGISTRATIONS",
      can_view: true,
      can_create: false,
      can_update: true,
      can_delete: false,
      can_import: false,
      can_export: false,
      can_notify: false,
      created_by: IDS.user,
      updated_by: IDS.user,
    },
  ], "a grant with no action is left out");
  assert.deepEqual(fakes.create.mock.calls[0]?.arguments[0], {
    organization_id: IDS.orgA,
    code: "GATE",
    name: "Gate",
    description: "At the door",
    is_active: true,
    created_by: IDS.user,
    updated_by: IDS.user,
  });
});

test("a role's code and name are unique in the organization (the name ignoring case)", async () => {
  arrange();
  await assert.rejects(roleService.createRole(IDS.orgA, { code: "VIEWER", name: "Readers", description: undefined, grants: [] }, EDITOR), (error: unknown) => {
    assert.ok(error instanceof ConflictError);
    assert.deepEqual(error.details, { field: "code" });
    return true;
  });
  await assert.rejects(roleService.createRole(IDS.orgA, { code: "READERS", name: " door STAFF ", description: undefined, grants: [] }, EDITOR), (error: unknown) => {
    assert.ok(error instanceof ConflictError);
    assert.deepEqual(error.details, { field: "name" });
    return true;
  });
  assert.equal(order.includes("create"), false);
});

test("platform modules, ORGANIZATIONS create and unknown modules are refused with 400, naming each, even by someone who holds none of them", async () => {
  const fakes = arrange({ allowed: () => false });
  const refused = roleService.createRole(
    IDS.orgA,
    {
      code: "ROGUE",
      name: "Rogue",
      description: undefined,
      grants: [grant("MODULES", { view: true }), grant("ORGANIZATIONS", { view: true, create: true }), grant("NOPE", { view: true }), grant("EVENTS", { view: true })],
    },
    EDITOR,
  );
  await assert.rejects(refused, (error: unknown) => {
    assert.ok(error instanceof ValidationAppError);
    const issues = (error.details as { issues: Array<{ path: string; code: string }> }).issues;
    assert.deepEqual(
      issues.map((issue) => [issue.path, issue.code]),
      [
        ["body.grants.0.module_code", "module_not_grantable"],
        ["body.grants.1.create", "action_not_grantable"],
        ["body.grants.2.module_code", "module_not_grantable"],
      ],
    );
    return true;
  });
  assert.equal(fakes.permission.mock.callCount(), 0, "checked before escalation: an impossible grant is 400, never 403");
});

test("nobody grants what they don't hold: a custom role with Roles › update can't hand out Events › create (403)", async () => {
  const fakes = arrange({ allowed: (moduleCode, action) => !(moduleCode === "EVENTS" && action === "create") });
  await assert.rejects(
    roleService.createRole(IDS.orgA, { code: "PLANNER", name: "Planner", description: undefined, grants: [grant("EVENTS", { view: true, create: true })] }, EDITOR),
    (error: unknown) => {
      assert.ok(error instanceof GrantExceedsOwnAccessError);
      assert.equal(error.statusCode, 403);
      assert.deepEqual(error.details, { module_code: "EVENTS", action: "create" });
      return true;
    },
  );
  assert.equal(order.includes("create"), false, "nothing written");
  const asked = fakes.permission.mock.calls[0]?.arguments[0];
  assert.deepEqual([asked?.userId, asked?.assignmentId, asked?.scope], [IDS.user, IDS.assignment, { level: "organization", organizationId: IDS.orgA, branchId: null }]);
});

test("someone allowed everything (an Owner, or the Super Admin through the engine's bypass) may grant anything grantable", async () => {
  const fakes = arrange();
  const everything = Object.entries(TENANT_GRANTABLE).map(([moduleCode, actions]) =>
    grant(moduleCode, Object.fromEntries(actions.map((action) => [action, true]))),
  );
  await roleService.createRole(IDS.orgA, { code: "DEPUTY", name: "Deputy", description: undefined, grants: everything }, EDITOR);
  assert.equal(fakes.replace.mock.callCount(), 1);
  assert.equal(fakes.permission.mock.callCount(), Object.values(TENANT_GRANTABLE).flat().length);
});

test("editing checks only newly added actions: keeping what a role already has needs no access of your own", async () => {
  const fakes = arrange({
    stored: [storedGrant(DOOR.id, "REGISTRATIONS", { view: true, update: true })],
    allowed: (moduleCode, action) => moduleCode === "CUSTOMERS" && action === "view",
  });
  await roleService.updateRole(
    IDS.orgA,
    DOOR.id,
    { grants: [grant("REGISTRATIONS", { view: true, update: true }), grant("CUSTOMERS", { view: true })], description: undefined },
    EDITOR,
  );
  assert.deepEqual(
    fakes.permission.mock.calls.map((call) => [call.arguments[0].moduleCode, call.arguments[0].action]),
    [["CUSTOMERS", "view"]],
  );
  assert.deepEqual(order, ["transaction", "replace", "update"]);
  assert.deepEqual(fakes.byId.mock.calls[0]?.arguments[2], { transaction: FAKE_TX, lock: true }, "the role is locked while it changes");
});

test("the built-in OWNER is locked: it can't be renamed, re-granted or switched off", async () => {
  arrange();
  await assert.rejects(roleService.updateRole(IDS.orgA, OWNER.id, { name: "Boss", description: undefined }, EDITOR), RoleLockedError);
  await assert.rejects(roleService.updateRole(IDS.orgA, OWNER.id, { grants: [], description: undefined }, EDITOR), RoleLockedError);
  await assert.rejects(roleService.changeRoleStatus(IDS.orgA, OWNER.id, false, EDITOR), RoleLockedError);
  assert.deepEqual(order.filter((step) => step !== "transaction"), [], "nothing written");
});

test("VIEWER is editable like any custom role; its code never changes", async () => {
  const fakes = arrange();
  await roleService.updateRole(IDS.orgA, VIEWER.id, { name: "Read only", description: "Sees everything, changes nothing" }, EDITOR);
  assert.deepEqual(fakes.update.mock.calls[0]?.arguments.slice(0, 3), [
    IDS.orgA,
    VIEWER.id,
    { name: "Read only", description: "Sees everything, changes nothing", updated_by: IDS.user },
  ]);
  assert.equal(fakes.replace.mock.callCount(), 0, "grants untouched when not sent");
});

test("renaming to another role's name is refused; keeping its own name is fine", async () => {
  arrange();
  await assert.rejects(roleService.updateRole(IDS.orgA, DOOR.id, { name: "viewer", description: undefined }, EDITOR), ConflictError);
  await roleService.updateRole(IDS.orgA, DOOR.id, { name: "Door Staff", description: undefined }, EDITOR);
});

test("a role staff still hold can't be switched off (409 role_in_use with the count); switching on is always allowed", async () => {
  arrange({ holders: 2 });
  await assert.rejects(roleService.changeRoleStatus(IDS.orgA, DOOR.id, false, EDITOR), (error: unknown) => {
    assert.ok(error instanceof RoleInUseError);
    assert.deepEqual([error.statusCode, error.code, error.details], [409, "role_in_use", { active_assignments: 2 }]);
    return true;
  });

  mock.restoreAll();
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
  const off = roleRow({ id: "role-off", code: "OLD", name: "Old", is_active: false });
  const fakes = arrange({ roles: [OWNER, off], holders: 5 });
  await roleService.changeRoleStatus(IDS.orgA, off.id, true, EDITOR);
  assert.deepEqual(fakes.update.mock.calls[0]?.arguments[2], { is_active: true, updated_by: IDS.user });
  assert.equal(fakes.holders.mock.callCount(), 0);
});

test("asking for the state a role is already in changes nothing", async () => {
  const fakes = arrange();
  await roleService.changeRoleStatus(IDS.orgA, DOOR.id, true, EDITOR);
  assert.equal(fakes.update.mock.callCount(), 0);
});

test("TENANT_GRANTABLE never offers platform modules or ORGANIZATIONS create, and covers every default-role grant", () => {
  assert.equal(TENANT_GRANTABLE.MODULES, undefined);
  assert.equal(TENANT_GRANTABLE.ROLE_TEMPLATES, undefined);
  assert.equal(TENANT_GRANTABLE.USER_MODULE_ACCESSES, undefined);
  assert.deepEqual(TENANT_GRANTABLE.ORGANIZATIONS, ["view", "update", "import", "export", "notify"], "never create or delete");
  assert.deepEqual(TENANT_GRANTABLE.EVENTS, ["view", "create", "update", "delete", "import", "export", "notify"], "all 7 elsewhere (Phase 2e)");
  for (const role of DEFAULT_TENANT_ROLES) {
    for (const defaultGrant of role.grants) {
      const allowed: readonly string[] = TENANT_GRANTABLE[defaultGrant.moduleCode] ?? [];
      const actions: readonly string[] = defaultGrant.actions;
      assert.ok(actions.every((action) => allowed.includes(action)), `${role.code} ${defaultGrant.moduleCode}`);
    }
  }
  const owner = DEFAULT_TENANT_ROLES.find((role) => role.code === "OWNER");
  assert.deepEqual(owner?.grants.find((entry) => entry.moduleCode === "ROLES")?.actions, ["view", "create", "update", "delete", "import", "export", "notify"], "Owners manage roles");
});

// --- The Export right (Phase 4d) ---------------------------------------------------------------

test("all 7 actions are grantable on tenant modules (Phase 2e); Organizations create and delete are a 400 naming the box", async () => {
  const fakes = arrange();
  await roleService.createRole(
    IDS.orgA,
    { code: "CLERK", name: "Clerk", description: undefined, grants: [grant("REGISTRATIONS", { view: true, delete: true, import: true, notify: true }), grant("EVENTS", { view: true, export: true })] },
    EDITOR,
  );
  const [, rows] = fakes.replace.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(
    (rows as Array<Record<string, boolean | string>>).map((row) => [row.module_id, row.can_delete, row.can_import, row.can_export, row.can_notify]),
    [
      ["module-REGISTRATIONS", true, true, false, true],
      ["module-EVENTS", false, false, true, false],
    ],
  );

  await assert.rejects(
    roleService.createRole(IDS.orgA, { code: "BAD", name: "Bad", description: undefined, grants: [grant("ORGANIZATIONS", { view: true, create: true, delete: true })] }, EDITOR),
    (error: unknown) => {
      assert.ok(error instanceof ValidationAppError);
      const issues = (error.details as { issues: Array<{ path: string; code: string }> }).issues;
      assert.deepEqual(issues.map((issue) => [issue.path, issue.code]), [
        ["body.grants.0.create", "action_not_grantable"],
        ["body.grants.0.delete", "action_not_grantable"],
      ]);
      return true;
    },
  );
});

test("a box left out: no on create; on update the role keeps the value it has (export shown here), with no escalation check for it", async () => {
  const created = arrange();
  await roleService.createRole(IDS.orgA, { code: "GATE", name: "Gate", description: undefined, grants: [grant("REGISTRATIONS", { view: true })] }, EDITOR);
  assert.equal((created.replace.mock.calls[0]?.arguments[1] as Array<{ can_export: boolean }>)[0]?.can_export, false);
  mock.restoreAll();
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));

  const fakes = arrange({ stored: [storedGrant(DOOR.id, "REGISTRATIONS", { view: true, export: true })], allowed: () => false });
  await roleService.updateRole(IDS.orgA, DOOR.id, { grants: [grant("REGISTRATIONS", { view: true })], description: undefined }, EDITOR);
  assert.equal((fakes.replace.mock.calls[0]?.arguments[1] as Array<{ can_export: boolean }>)[0]?.can_export, true, "kept, not wiped");
  assert.equal(fakes.permission.mock.callCount(), 0, "keeping what the role has needs no access of your own");

  await roleService.updateRole(IDS.orgA, DOOR.id, { grants: [grant("REGISTRATIONS", { view: true, export: false })], description: undefined }, EDITOR);
  assert.equal((fakes.replace.mock.calls[1]?.arguments[1] as Array<{ can_export: boolean }>)[0]?.can_export, false, "an explicit false removes it");
});

test("nobody grants Export without holding it (403 grant_exceeds_own_access)", async () => {
  arrange({ allowed: (moduleCode, action) => !(moduleCode === "REGISTRATIONS" && action === "export") });
  await assert.rejects(
    roleService.createRole(IDS.orgA, { code: "LISTS", name: "Lists", description: undefined, grants: [grant("REGISTRATIONS", { view: true, export: true })] }, EDITOR),
    (error: unknown) => error instanceof GrantExceedsOwnAccessError && JSON.stringify(error.details) === JSON.stringify({ module_code: "REGISTRATIONS", action: "export" }),
  );
});

test("Owners hold all 7 actions on Guests by default; Viewers only view", () => {
  const actionsOf = (code: string) => DEFAULT_TENANT_ROLES.find((role) => role.code === code)?.grants.find((entry) => entry.moduleCode === "REGISTRATIONS")?.actions;
  assert.deepEqual(actionsOf("OWNER"), ["view", "create", "update", "delete", "import", "export", "notify"]);
  assert.deepEqual(actionsOf("VIEWER"), ["view"]);
});

// --- Phase 2e step 1: counts on roles -----------------------------------------------------------------------

test("roles carry how many modules they give access to and how many active staff hold them", async () => {
  const fakes = arrange({ stored: [storedGrant(DOOR.id, "REGISTRATIONS", { view: true }), storedGrant(DOOR.id, "EVENTS", {})] });
  fakes.members.mock.mockImplementation(async () => new Map([[DOOR.id, 3]]));
  const roles = await roleService.listRoles(IDS.orgA);
  const door = roles.find((role) => role.code === "DOOR_STAFF");
  assert.deepEqual([door?.grant_count, door?.member_count], [1, 3], "a grant with no action doesn't count");
  assert.equal(roles.find((role) => role.code === "VIEWER")?.member_count, 0);
});

// --- Phase 2e step 2: the grantable modules list ----------------------------------------------------------

test("the grantable modules list is the active permission modules that TENANT_GRANTABLE allows, with their actions", async () => {
  arrange();
  const modules = await roleService.listGrantableModules(IDS.orgA);
  assert.deepEqual(modules.map((module) => module.module_code), ["ORGANIZATIONS", "BRANCHES", "ROLES", "USER_ROLES", "EVENTS", "CUSTOMERS", "REGISTRATIONS"], "never platform modules");
  assert.deepEqual(modules.find((module) => module.module_code === "ORGANIZATIONS")?.actions, TENANT_GRANTABLE.ORGANIZATIONS);
  assert.deepEqual(modules.find((module) => module.module_code === "REGISTRATIONS")?.actions, TENANT_GRANTABLE.REGISTRATIONS);
});
