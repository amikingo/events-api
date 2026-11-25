import type { QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Phase 2b: Owners manage their organization's staff in the app. Existing tenant OWNER roles gain create and update
 * on USER_ROLES (Staff Assignments); they already had view. Matches utils/default-roles.ts for new organizations.
 * Data only: no table changes.
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(
      `INSERT INTO "role_module_access" ("role_id", "module_id", "can_view", "can_create", "can_update")
       SELECT r."id", m."id", true, true, true
         FROM "role" r
         CROSS JOIN "module" m
        WHERE r."organization_id" IS NOT NULL AND r."code" = 'OWNER' AND m."code" = 'USER_ROLES'
       ON CONFLICT ("role_id", "module_id") DO UPDATE SET "can_create" = true, "can_update" = true, "updated_at" = now()`,
      { transaction },
    );
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(
      `UPDATE "role_module_access" SET "can_create" = false, "can_update" = false, "updated_at" = now()
        WHERE "module_id" IN (SELECT "id" FROM "module" WHERE "code" = 'USER_ROLES')
          AND "role_id" IN (SELECT "id" FROM "role" WHERE "organization_id" IS NOT NULL AND "code" = 'OWNER')`,
      { transaction },
    );
  });
};
