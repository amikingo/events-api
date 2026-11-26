import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Phase 7 step 3: the organizer's Cheche Pay service code, as in bookings (`nw_organization_setting.cheche_pay_service`).
 * The code decides which merchant receives the money: its payment options (Telebirr and others) come from
 * pay.cheche.et …/payment-services/<code>. Set by the platform Super Admin only, stored upper-case. NULL means paid
 * sales are off for the organizer (unlike bookings, there is no fallback to a central merchant: the event's organizer
 * receives the money directly).
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.addColumn("organization", "cheche_pay_service", { type: DataTypes.STRING(80), allowNull: true }, { transaction });
    await queryInterface.sequelize.query(
      `ALTER TABLE "organization"
         ADD CONSTRAINT "ck_organization_cheche_pay_service_format" CHECK ("cheche_pay_service" IS NULL OR "cheche_pay_service" ~ '^[A-Z0-9_-]{1,80}$')`,
      { transaction },
    );
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.removeColumn("organization", "cheche_pay_service", { transaction });
  });
};
