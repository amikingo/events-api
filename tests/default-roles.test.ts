import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKFILL_GRANTS } from "../src/migrations/20261127000100-backfill-default-roles.js";
import { DEFAULT_TENANT_ROLES } from "../src/utils/default-roles.js";

/** The backfill migration writes its grants out; today they must equal what a new organization gets. */
test("the default-roles backfill grants exactly what a new organization's OWNER and VIEWER get today", () => {
  const fromCode = DEFAULT_TENANT_ROLES.flatMap((role) =>
    role.grants.map((grant) => {
      const actions: readonly string[] = grant.actions;
      return [role.code, grant.moduleCode, actions.includes("view"), actions.includes("create"), actions.includes("update")].join(":");
    }),
  ).sort();
  const fromMigration = BACKFILL_GRANTS.map((grant) => grant.join(":")).sort();
  assert.deepEqual(fromMigration, fromCode);
  for (const role of DEFAULT_TENANT_ROLES) {
    for (const grant of role.grants) {
      const actions: readonly string[] = grant.actions;
      assert.ok(actions.every((action) => ["view", "create", "update"].includes(action)), `${role.code} ${grant.moduleCode}: only view, create and update are backfilled`);
    }
  }
});
