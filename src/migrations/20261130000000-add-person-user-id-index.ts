import type { QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Phase 6: My Tickets finds a guest's linked profiles in every organization by their Cheche account id. The existing
 * unique index (organization_id, user_id) can't serve a lookup by user_id alone, so this adds one, for linked
 * profiles only. No data changes.
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(`CREATE INDEX "idx_person_user_id" ON "person" ("user_id") WHERE "user_id" IS NOT NULL`, { transaction });
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "idx_person_user_id"`, { transaction });
  });
};
