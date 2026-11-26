import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Phase 7 step 3b: paid checkout moves to Cheche Pay v2, where each organizer has its own secret key
 * (organization_cheche_pay_credential). The legacy service code is no longer used. Down adds the column back, empty.
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(`ALTER TABLE "organization" DROP CONSTRAINT IF EXISTS "ck_organization_cheche_pay_service_format"`, { transaction });
    await queryInterface.removeColumn("organization", "cheche_pay_service", { transaction });
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.addColumn("organization", "cheche_pay_service", { type: DataTypes.STRING(80), allowNull: true }, { transaction });
    await queryInterface.sequelize.query(
      `ALTER TABLE "organization"
         ADD CONSTRAINT "ck_organization_cheche_pay_service_format" CHECK ("cheche_pay_service" IS NULL OR "cheche_pay_service" ~ '^[A-Z0-9_-]{1,80}$')`,
      { transaction },
    );
  });
};
