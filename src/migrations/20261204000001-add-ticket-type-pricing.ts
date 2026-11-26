import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Phase 7 step 1: a price and an audience per ticket type.
 * - price: exact (NUMERIC(12,2)); 0 means free, more means paid. One event may offer both.
 * - currency: the organizer's currency, copied when the ticket type is created (existing rows: the organization's
 *   default_currency today).
 * - audience: PUBLIC (anyone with the link) or STAFF_ONLY (only authorized staff may issue it).
 * Existing ticket types become free and public, so nothing changes for them.
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.addColumn("ticket_type", "price", { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 }, { transaction });
    await queryInterface.addColumn("ticket_type", "currency", { type: DataTypes.STRING(3), allowNull: true }, { transaction });
    await queryInterface.addColumn("ticket_type", "audience", { type: DataTypes.STRING(20), allowNull: false, defaultValue: "PUBLIC" }, { transaction });
    await queryInterface.sequelize.query(
      `UPDATE "ticket_type" t SET "currency" = o."default_currency" FROM "organization" o WHERE o."id" = t."organization_id"`,
      { transaction },
    );
    await queryInterface.changeColumn("ticket_type", "currency", { type: DataTypes.STRING(3), allowNull: false }, { transaction });
    await queryInterface.sequelize.query(
      `ALTER TABLE "ticket_type"
         ADD CONSTRAINT "ck_ticket_type_price_non_negative" CHECK ("price" >= 0),
         ADD CONSTRAINT "ck_ticket_type_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
         ADD CONSTRAINT "ck_ticket_type_audience" CHECK ("audience" IN ('PUBLIC', 'STAFF_ONLY'))`,
      { transaction },
    );
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.removeColumn("ticket_type", "audience", { transaction });
    await queryInterface.removeColumn("ticket_type", "currency", { transaction });
    await queryInterface.removeColumn("ticket_type", "price", { transaction });
  });
};
