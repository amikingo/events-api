import type { QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Phase 8 step 3: the OWNER role template gets every action on PAYMENTS too, so new organizations' Owners match
 * existing ones (20261208000002). Data only.
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(
      `INSERT INTO "role_template_module_access" ("role_template_id", "module_id", "can_view", "can_create", "can_update", "can_delete", "can_import", "can_export", "can_notify")
       SELECT t."id", m."id", true, true, true, true, true, true, true
         FROM "role_template" t CROSS JOIN "module" m
        WHERE t."code" = 'OWNER' AND m."code" = 'PAYMENTS'
       ON CONFLICT ("role_template_id", "module_id") DO NOTHING`,
      { transaction },
    );
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(
      `DELETE FROM "role_template_module_access"
        WHERE "module_id" IN (SELECT "id" FROM "module" WHERE "code" = 'PAYMENTS')
          AND "role_template_id" IN (SELECT "id" FROM "role_template" WHERE "code" = 'OWNER')`,
      { transaction },
    );
  });
};
