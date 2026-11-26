import type { QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Phase 2e: the OWNER role template gets the same new actions as existing Owner roles (20261202000000), so new
 * organizations' Owners hold every action a tenant may hold. Data only.
 */
const FULL_MODULES = ["BRANCHES", "ROLES", "USER_ROLES", "EVENTS", "CUSTOMERS", "REGISTRATIONS"];

export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(
      `UPDATE "role_template_module_access" SET "can_delete" = true, "can_import" = true, "can_export" = true, "can_notify" = true, "updated_at" = now()
        WHERE "role_template_id" IN (SELECT "id" FROM "role_template" WHERE "code" = 'OWNER')
          AND "module_id" IN (SELECT "id" FROM "module" WHERE "code" IN (:full))`,
      { replacements: { full: FULL_MODULES }, transaction },
    );
    await queryInterface.sequelize.query(
      `UPDATE "role_template_module_access" SET "can_import" = true, "can_export" = true, "can_notify" = true, "updated_at" = now()
        WHERE "role_template_id" IN (SELECT "id" FROM "role_template" WHERE "code" = 'OWNER')
          AND "module_id" IN (SELECT "id" FROM "module" WHERE "code" = 'ORGANIZATIONS')`,
      { transaction },
    );
  });
};

/** Back to the seed: the OWNER template keeps export on REGISTRATIONS only. */
export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(
      `UPDATE "role_template_module_access" SET "can_delete" = false, "can_import" = false, "can_notify" = false,
              "can_export" = (SELECT m."code" = 'REGISTRATIONS' FROM "module" m WHERE m."id" = "role_template_module_access"."module_id"),
              "updated_at" = now()
        WHERE "role_template_id" IN (SELECT "id" FROM "role_template" WHERE "code" = 'OWNER')`,
      { transaction },
    );
  });
};
