import type { QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Phase 2e (decided 26 November 2026): all 7 actions are grantable, so Owners must hold every action a tenant may hold,
 * or the escalation rule would stop them granting the new ones. This adds delete, import, export and notify to every
 * tenant module of each tenant OWNER role; ORGANIZATIONS gets import, export and notify only (never create or delete).
 * Matches utils/default-roles.ts. Data only; tests/default-roles.test.ts layers it on the earlier grants.
 */
export const OWNER_ALL_ACTIONS_GRANT: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ORGANIZATIONS: ["import", "export", "notify"],
  BRANCHES: ["delete", "import", "export", "notify"],
  ROLES: ["delete", "import", "export", "notify"],
  USER_ROLES: ["delete", "import", "export", "notify"],
  EVENTS: ["delete", "import", "export", "notify"],
  CUSTOMERS: ["delete", "import", "export", "notify"],
  REGISTRATIONS: ["delete", "import", "export", "notify"],
});

const FULL_MODULES = ["BRANCHES", "ROLES", "USER_ROLES", "EVENTS", "CUSTOMERS", "REGISTRATIONS"];

export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(
      `UPDATE "role_module_access" SET "can_delete" = true, "can_import" = true, "can_export" = true, "can_notify" = true, "updated_at" = now()
        WHERE "role_id" IN (SELECT "id" FROM "role" WHERE "organization_id" IS NOT NULL AND "code" = 'OWNER')
          AND "module_id" IN (SELECT "id" FROM "module" WHERE "code" IN (:full))`,
      { replacements: { full: FULL_MODULES }, transaction },
    );
    await queryInterface.sequelize.query(
      `UPDATE "role_module_access" SET "can_import" = true, "can_export" = true, "can_notify" = true, "updated_at" = now()
        WHERE "role_id" IN (SELECT "id" FROM "role" WHERE "organization_id" IS NOT NULL AND "code" = 'OWNER')
          AND "module_id" IN (SELECT "id" FROM "module" WHERE "code" = 'ORGANIZATIONS')`,
      { transaction },
    );
  });
};

/** Back to the 4d grants: Owners keep export on REGISTRATIONS only. */
export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(
      `UPDATE "role_module_access" SET "can_delete" = false, "can_import" = false, "can_notify" = false,
              "can_export" = (SELECT m."code" = 'REGISTRATIONS' FROM "module" m WHERE m."id" = "role_module_access"."module_id"),
              "updated_at" = now()
        WHERE "role_id" IN (SELECT "id" FROM "role" WHERE "organization_id" IS NOT NULL AND "code" = 'OWNER')`,
      { transaction },
    );
  });
};
