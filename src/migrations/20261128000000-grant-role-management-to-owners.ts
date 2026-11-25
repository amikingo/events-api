import type { QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/** What this migration adds to every tenant OWNER role (tests/default-roles.test.ts applies it on top of BACKFILL_GRANTS). */
export const ROLE_MANAGEMENT_GRANT = Object.freeze({ role: "OWNER", module: "ROLES", actions: ["view", "create", "update"] as const });

/**
 * Phase 2c: Owners create and edit their organization's roles in the app. Existing tenant OWNER roles gain create and
 * update on ROLES; they already had view. Matches utils/default-roles.ts for new organizations. Data only.
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(
      `INSERT INTO "role_module_access" ("role_id", "module_id", "can_view", "can_create", "can_update")
       SELECT r."id", m."id", true, true, true
         FROM "role" r
         CROSS JOIN "module" m
        WHERE r."organization_id" IS NOT NULL AND r."code" = 'OWNER' AND m."code" = 'ROLES'
       ON CONFLICT ("role_id", "module_id") DO UPDATE SET "can_view" = true, "can_create" = true, "can_update" = true, "updated_at" = now()`,
      { transaction },
    );
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(
      `UPDATE "role_module_access" SET "can_create" = false, "can_update" = false, "updated_at" = now()
        WHERE "module_id" IN (SELECT "id" FROM "module" WHERE "code" = 'ROLES')
          AND "role_id" IN (SELECT "id" FROM "role" WHERE "organization_id" IS NOT NULL AND "code" = 'OWNER')`,
      { transaction },
    );
  });
};
