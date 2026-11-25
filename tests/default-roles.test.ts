import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKFILL_GRANTS } from "../src/migrations/20261127000100-backfill-default-roles.js";
import { ROLE_MANAGEMENT_GRANT } from "../src/migrations/20261128000000-grant-role-management-to-owners.js";
import { DEFAULT_TENANT_ROLES } from "../src/utils/default-roles.js";

/**
 * The backfill migration (already applied, so never edited) writes its grants out; with the later grant migrations on
 * top, they must equal what a new organization gets today.
 */
test("the default-roles backfill plus later grant migrations equal what a new organization's OWNER and VIEWER get today", () => {
  const fromCode = DEFAULT_TENANT_ROLES.flatMap((role) =>
    role.grants.map((grant) => {
      const actions: readonly string[] = grant.actions;
      return [role.code, grant.moduleCode, actions.includes("view"), actions.includes("create"), actions.includes("update")].join(":");
    }),
  ).sort();
  const later = ROLE_MANAGEMENT_GRANT;
  const fromMigration = BACKFILL_GRANTS.map(([role, module, view, create, update]) =>
    role === later.role && module === later.module
      ? [role, module, view || later.actions.includes("view"), create || later.actions.includes("create"), update || later.actions.includes("update")]
      : [role, module, view, create, update],
  )
    .map((grant) => grant.join(":"))
    .sort();
  assert.deepEqual(fromMigration, fromCode);
  for (const role of DEFAULT_TENANT_ROLES) {
    for (const grant of role.grants) {
      const actions: readonly string[] = grant.actions;
      assert.ok(actions.every((action) => ["view", "create", "update"].includes(action)), `${role.code} ${grant.moduleCode}: only view, create and update are backfilled`);
    }
  }
});
