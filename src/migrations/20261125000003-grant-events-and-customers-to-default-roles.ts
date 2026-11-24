import type { QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Extends existing organizations' default roles with the Phase 3 modules, matching utils/default-roles.ts for new
 * organizations: OWNER may view, create and update events and clients; VIEWER may view them. Roles an organization
 * customized keep any grant they already have (ON CONFLICT DO NOTHING).
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(
      `INSERT INTO "role_module_access" ("role_id", "module_id", "can_view", "can_create", "can_update")
       SELECT r."id", m."id", true, r."code" = 'OWNER', r."code" = 'OWNER'
         FROM "role" r
         CROSS JOIN "module" m
        WHERE r."organization_id" IS NOT NULL
          AND r."code" IN ('OWNER', 'VIEWER')
          AND m."code" IN ('EVENTS', 'CUSTOMERS')
       ON CONFLICT ("role_id", "module_id") DO NOTHING`,
      { transaction },
    );
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(
      `DELETE FROM "role_module_access"
        WHERE "module_id" IN (SELECT "id" FROM "module" WHERE "code" IN ('EVENTS', 'CUSTOMERS'))
          AND "role_id" IN (SELECT "id" FROM "role" WHERE "organization_id" IS NOT NULL AND "code" IN ('OWNER', 'VIEWER'))`,
      { transaction },
    );
  });
};
