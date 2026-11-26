import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { Transaction } from "sequelize";
import { ConflictError, RoleLockedError, ValidationAppError } from "../src/errors/app-errors.js";
import { SEED_ROLE_TEMPLATES } from "../src/migrations/20261201000002-seed-role-templates.js";
import { OWNER_ALL_ACTIONS_GRANT } from "../src/migrations/20261202000000-grant-all-actions-to-owner-roles.js";
import type { RoleTemplateRow } from "../src/models/role-template.js";
import { moduleRepository } from "../src/repositories/module.repository.js";
import { roleRepository } from "../src/repositories/role.repository.js";
import { roleTemplateRepository, type RoleTemplateGrantRow } from "../src/repositories/role-template.repository.js";
import { transactionManager } from "../src/services/helpers.js";
import { roleTemplateService } from "../src/services/role-template.service.js";
import { DEFAULT_TENANT_ROLES } from "../src/utils/default-roles.js";
import { IDS, moduleRow } from "./helpers/fixtures.js";

/** Role templates (Phase 2d) against mocked repositories and a fake transaction: no database. */
const FAKE_TX = { id: "fake-transaction" } as unknown as Transaction;
const MODULES = ["ORGANIZATIONS", "EVENTS", "REGISTRATIONS", "MODULES"].map((code) => moduleRow({ id: `module-${code}`, code, module_name: code }));
const audit = { created_at: new Date("2026-01-01T00:00:00Z"), updated_at: new Date("2026-01-01T00:00:00Z"), created_by: null, updated_by: null };
const template = (overrides: Partial<RoleTemplateRow>): RoleTemplateRow => ({
  id: "template-x",
  code: "X",
  name: "X",
  description: null,
  is_active: true,
  for_new_organizations: false,
  ...audit,
  ...overrides,
});
const OWNER_T = template({ id: "template-owner", code: "OWNER", name: "Owner", for_new_organizations: true });
const DOOR_T = template({ id: "template-door", code: "DOOR_STAFF", name: "Door staff" });
const grantRow = (templateId: string, moduleCode: string, flags: Partial<Record<"can_view" | "can_update" | "can_export", boolean>>) =>
  ({
    role_template_id: templateId,
    module_id: `module-${moduleCode}`,
    can_view: false,
    can_create: false,
    can_update: false,
    can_delete: false,
    can_import: false,
    can_export: false,
    can_notify: false,
    ...flags,
    module: { code: moduleCode, module_name: moduleCode, sno: 1 },
  }) as unknown as RoleTemplateGrantRow;

type Box = "view" | "create" | "update" | "delete" | "import" | "export" | "notify";
const grant = (module_code: string, actions: Partial<Record<Box, boolean>>) => ({
  module_code,
  view: actions.view ?? false,
  create: actions.create ?? false,
  update: actions.update ?? false,
  ...(actions.delete === undefined ? {} : { delete: actions.delete }),
  ...(actions.import === undefined ? {} : { import: actions.import }),
  ...(actions.export === undefined ? {} : { export: actions.export }),
  ...(actions.notify === undefined ? {} : { notify: actions.notify }),
});

function arrange(templates: RoleTemplateRow[] = [OWNER_T, DOOR_T], grants: RoleTemplateGrantRow[] = []) {
  const rows = [...templates];
  return {
    list: mock.method(roleTemplateRepository, "list", async (filters: { activeOnly?: boolean; forNewOrganizations?: boolean } = {}) =>
      rows.filter((row) => (!filters.activeOnly || row.is_active) && (!filters.forNewOrganizations || row.for_new_organizations)),
    ),
    byId: mock.method(roleTemplateRepository, "findById", async (id: string, _options?: unknown) => rows.find((row) => row.id === id) ?? null),
    byCode: mock.method(roleTemplateRepository, "findByCode", async (code: string) => rows.find((row) => row.code === code) ?? null),
    create: mock.method(roleTemplateRepository, "create", async (values: Partial<RoleTemplateRow>, _options?: unknown) => {
      const created = template({ ...values, id: "template-new" });
      rows.push(created);
      return created;
    }),
    update: mock.method(roleTemplateRepository, "updateById", async (_id: string, _values: Record<string, unknown>, _options?: unknown) => null),
    grants: mock.method(roleTemplateRepository, "listGrantsWithModules", async () => grants),
    replace: mock.method(roleTemplateRepository, "replaceGrants", async (_id: string, _rows: unknown[], _options: { transaction: Transaction }) => undefined),
    modules: mock.method(moduleRepository, "listActiveOrdered", async () => MODULES),
  };
}

beforeEach(() => {
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
});
afterEach(() => mock.restoreAll());

test("the seed migration's OWNER and VIEWER templates, plus the Phase 2e grant on OWNER, equal the code's DEFAULT_TENANT_ROLES", () => {
  const withLater = (code: string, moduleCode: string, actions: readonly string[]) =>
    code === "OWNER" ? [...new Set([...actions, ...(OWNER_ALL_ACTIONS_GRANT[moduleCode] ?? [])])] : [...actions];
  const fromSeed = SEED_ROLE_TEMPLATES.map((seed) => ({
    code: seed.code,
    name: seed.name,
    description: seed.description,
    grants: seed.grants.map(([moduleCode, actions]) => `${moduleCode}:${withLater(seed.code, moduleCode, actions).sort().join(",")}`).sort(),
  }));
  const fromCode = DEFAULT_TENANT_ROLES.map((role) => ({
    code: role.code,
    name: role.name,
    description: role.description,
    grants: role.grants.map((entry) => `${entry.moduleCode}:${[...entry.actions].sort().join(",")}`).sort(),
  }));
  assert.deepEqual(fromSeed, fromCode);
});

test("creating a template stores it with its grants in one transaction; it isn't for new organizations unless asked", async () => {
  const fakes = arrange();
  await roleTemplateService.createTemplate(
    { code: "GATE", name: "Gate", description: undefined, grants: [grant("REGISTRATIONS", { view: true, export: true }), grant("EVENTS", {})] },
    IDS.user,
  );
  const [values] = fakes.create.mock.calls[0]?.arguments ?? [];
  assert.deepEqual([values?.code, values?.for_new_organizations, values?.is_active], ["GATE", false, true]);
  const [templateId, rows, options] = fakes.replace.mock.calls[0]?.arguments ?? [];
  assert.equal(templateId, "template-new");
  assert.equal(options?.transaction, FAKE_TX);
  assert.deepEqual(
    (rows as Array<Record<string, unknown>>).map((row) => [row.module_id, row.can_view, row.can_export, row.can_delete]),
    [["module-REGISTRATIONS", true, true, false]],
    "a grant with no action is left out",
  );
});

test("template grants follow the tenant rules (400 before anything is written); codes and names are unique", async () => {
  const fakes = arrange();
  await assert.rejects(
    roleTemplateService.createTemplate({ code: "ROGUE", name: "Rogue", description: undefined, grants: [grant("MODULES", { view: true }), grant("ORGANIZATIONS", { delete: true })] }, IDS.user),
    (error: unknown) => {
      assert.ok(error instanceof ValidationAppError);
      const issues = (error.details as { issues: Array<{ path: string }> }).issues;
      assert.deepEqual(issues.map((issue) => issue.path), ["body.grants.0.module_code", "body.grants.1.delete"]);
      return true;
    },
  );
  assert.equal(fakes.create.mock.callCount(), 0);

  await assert.rejects(roleTemplateService.createTemplate({ code: "DOOR_STAFF", name: "Other", description: undefined, grants: [] }, IDS.user), (error: unknown) => {
    assert.ok(error instanceof ConflictError);
    assert.deepEqual(error.details, { field: "code" });
    return true;
  });
  await assert.rejects(roleTemplateService.createTemplate({ code: "OTHER", name: " door STAFF ", description: undefined, grants: [] }, IDS.user), ConflictError);
});

test("the OWNER template is locked: no edits and never switched off; other templates can be", async () => {
  const fakes = arrange();
  await assert.rejects(roleTemplateService.updateTemplate(OWNER_T.id, { name: "Boss", description: undefined }, IDS.user), RoleLockedError);
  await assert.rejects(roleTemplateService.updateTemplate(OWNER_T.id, { for_new_organizations: false, description: undefined }, IDS.user), RoleLockedError);
  await assert.rejects(roleTemplateService.changeTemplateStatus(OWNER_T.id, false, IDS.user), RoleLockedError);
  assert.equal(fakes.update.mock.callCount(), 0);

  await roleTemplateService.updateTemplate(DOOR_T.id, { for_new_organizations: true, description: undefined }, IDS.user);
  assert.deepEqual(fakes.update.mock.calls[0]?.arguments[1], { for_new_organizations: true, updated_by: IDS.user });
  await roleTemplateService.changeTemplateStatus(DOOR_T.id, false, IDS.user);
  assert.deepEqual(fakes.update.mock.calls[1]?.arguments[1], { is_active: false, updated_by: IDS.user });
});

test("new organizations get the active templates for new organizations, and fall back to the code's defaults without an OWNER template", async () => {
  const forNew = template({ id: "template-gate", code: "GATE", name: "Gate", for_new_organizations: true });
  arrange([OWNER_T, forNew, DOOR_T, template({ id: "template-off", code: "OFF", for_new_organizations: true, is_active: false })], [
    grantRow(OWNER_T.id, "REGISTRATIONS", { can_view: true, can_update: true, can_export: true }),
    grantRow(forNew.id, "REGISTRATIONS", { can_view: true }),
  ]);

  const templates = await roleTemplateService.templatesForNewOrganization(FAKE_TX);
  assert.deepEqual(templates.map((entry) => entry.code), ["OWNER", "GATE"], "active and for new organizations only");
  assert.deepEqual(templates.map((entry) => entry.templateId), [OWNER_T.id, forNew.id], "new roles remember their template");
  assert.deepEqual(templates[0]?.grants, [{ moduleCode: "REGISTRATIONS", actions: ["view", "update", "export"] }]);

  mock.restoreAll();
  arrange([forNew]);
  assert.equal(await roleTemplateService.templatesForNewOrganization(FAKE_TX), DEFAULT_TENANT_ROLES, "no OWNER template: the code's defaults");
});

test("the Super Admin sees every organization's roles made from a template", async () => {
  arrange();
  mock.method(roleRepository, "listByTemplate", async () => [
    { ...roleRowLike("role-1", "DOOR_STAFF"), organization: { id: IDS.orgA, name: "Selam Events", slug: "selam-events" } },
  ]);
  const roles = await roleTemplateService.listTemplateRoles(DOOR_T.id);
  assert.deepEqual(roles, [{ id: "role-1", code: "DOOR_STAFF", name: "DOOR_STAFF", is_active: true, organization: { id: IDS.orgA, name: "Selam Events", slug: "selam-events" } }]);
});

function roleRowLike(id: string, code: string) {
  return {
    id,
    organization_id: IDS.orgA,
    code,
    name: code,
    description: null,
    role_template_id: DOOR_T.id,
    is_active: true,
    ...audit,
  };
}
