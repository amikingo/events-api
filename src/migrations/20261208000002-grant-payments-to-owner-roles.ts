import type { QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Phase 8 step 3: existing organizations' OWNER roles get every action on PAYMENTS, matching utils/default-roles.ts
 * for new organizations (Owners hold every action a tenant may hold, so they can grant it to a finance role). VIEWER
 * gets nothing: payment cases are about money. Roles an organization customized keep what they have (ON CONFLICT DO
 * NOTHING). Data only; tests/default-roles.test.ts adds it to the earlier grants.
 */
export const PAYMENTS_OWNER_GRANT = Object.freeze({ role: "OWNER", module: "PAYMENTS", actions: ["view", "create", "update", "delete", "import", "export", "notify"] as const });

export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(
      `INSERT INTO "role_module_access" ("role_id", "module_id", "can_view", "can_create", "can_update", "can_delete", "can_import", "can_export", "can_notify")
       SELECT r."id", m."id", true, true, true, true, true, true, true
         FROM "role" r
         CROSS JOIN "module" m
        WHERE r."organization_id" IS NOT NULL
          AND r."code" = 'OWNER'
          AND m."code" = 'PAYMENTS'
       ON CONFLICT ("role_id", "module_id") DO NOTHING`,
      { transaction },
    );
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(
      `DELETE FROM "role_module_access"
        WHERE "module_id" IN (SELECT "id" FROM "module" WHERE "code" = 'PAYMENTS')
          AND "role_id" IN (SELECT "id" FROM "role" WHERE "organization_id" IS NOT NULL AND "code" = 'OWNER')`,
      { transaction },
    );
  });
};
