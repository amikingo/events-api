import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKFILL_GRANTS } from "../src/migrations/20261127000100-backfill-default-roles.js";
import { ROLE_MANAGEMENT_GRANT } from "../src/migrations/20261128000000-grant-role-management-to-owners.js";
import { GUEST_EXPORT_GRANT } from "../src/migrations/20261129000000-grant-guest-export-to-owners.js";
import { OWNER_ALL_ACTIONS_GRANT } from "../src/migrations/20261202000000-grant-all-actions-to-owner-roles.js";
import { PAYMENTS_OWNER_GRANT } from "../src/migrations/20261208000002-grant-payments-to-owner-roles.js";
import { DEFAULT_TENANT_ROLES } from "../src/utils/default-roles.js";

/**
 * The backfill migration (already applied, so never edited) writes its grants out; with the later grant migrations on
 * top, they must equal what a new organization gets today.
 */
test("the default-roles backfill plus later grant migrations equal what a new organization's OWNER and VIEWER get today", () => {
  const ACTIONS = ["view", "create", "update", "delete", "import", "export", "notify"] as const;
  const fromCode = DEFAULT_TENANT_ROLES.flatMap((role) =>
    role.grants.map((grant) => {
      const actions: readonly string[] = grant.actions;
      return [role.code, grant.moduleCode, ...ACTIONS.map((action) => actions.includes(action))].join(":");
    }),
  ).sort();
  // The backfill (view, create, update) has no export; each later migration adds its actions to one role's module.
  const later = [
    ROLE_MANAGEMENT_GRANT,
    GUEST_EXPORT_GRANT,
    ...Object.entries(OWNER_ALL_ACTIONS_GRANT).map(([module, actions]) => ({ role: "OWNER", module, actions })),
  ];
  const fromMigration = BACKFILL_GRANTS.map(([role, module, view, create, update]) => {
    const flags: Record<(typeof ACTIONS)[number], boolean> = { view, create, update, delete: false, import: false, export: false, notify: false };
    for (const grant of later) {
      if (grant.role !== role || grant.module !== module) continue;
      const actions: readonly string[] = grant.actions;
      for (const action of ACTIONS) flags[action] ||= actions.includes(action);
    }
    return [role, module, ...ACTIONS.map((action) => flags[action])].join(":");
  });
  // Modules added later get a new row of their own (Phase 8: PAYMENTS for OWNER).
  for (const grant of [PAYMENTS_OWNER_GRANT]) {
    const actions: readonly string[] = grant.actions;
    fromMigration.push([grant.role, grant.module, ...ACTIONS.map((action) => actions.includes(action))].join(":"));
  }
  fromMigration.sort();
  assert.deepEqual(fromMigration, fromCode);
  for (const role of DEFAULT_TENANT_ROLES) {
    for (const grant of role.grants) {
      const actions: readonly string[] = grant.actions;
      assert.ok(actions.every((action) => (ACTIONS as readonly string[]).includes(action)), `${role.code} ${grant.moduleCode}: known actions only`);
    }
  }
});
