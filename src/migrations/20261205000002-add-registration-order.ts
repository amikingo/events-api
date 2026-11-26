import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Phase 7 step 2: a registration is now one ticket of an order.
 * - order_id: the order it belongs to (existing rows: the order the backfill made with the same id). Tenant-safe
 *   composite foreign key.
 * - price_amount and currency: the ticket's price as it was at checkout (existing rows: free, the organizer's
 *   currency).
 * - person_id becomes optional: a QUICK ticket has no holder profile. The unique (organization, event, person) stays,
 *   and NULLs never clash, so a known person still has one place per event.
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.addColumn("registration", "order_id", { type: DataTypes.UUID, allowNull: true }, { transaction });
    await queryInterface.addColumn("registration", "price_amount", { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 }, { transaction });
    await queryInterface.addColumn("registration", "currency", { type: DataTypes.STRING(3), allowNull: true }, { transaction });
    await queryInterface.sequelize.query(
      `UPDATE "registration" r SET "order_id" = r."id", "currency" = o."default_currency" FROM "organization" o WHERE o."id" = r."organization_id"`,
      { transaction },
    );
    await queryInterface.changeColumn("registration", "order_id", { type: DataTypes.UUID, allowNull: false }, { transaction });
    await queryInterface.changeColumn("registration", "currency", { type: DataTypes.STRING(3), allowNull: false }, { transaction });
    await queryInterface.changeColumn("registration", "person_id", { type: DataTypes.UUID, allowNull: true }, { transaction });
    await queryInterface.sequelize.query(
      `ALTER TABLE "registration"
         ADD CONSTRAINT "fk_registration_organization_order" FOREIGN KEY ("organization_id", "order_id")
           REFERENCES "ticket_order" ("organization_id", "id") ON UPDATE CASCADE ON DELETE RESTRICT,
         ADD CONSTRAINT "ck_registration_price_non_negative" CHECK ("price_amount" >= 0),
         ADD CONSTRAINT "ck_registration_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$')`,
      { transaction },
    );
    await queryInterface.addIndex("registration", ["organization_id", "order_id"], { name: "idx_registration_order", transaction });
  });
};

/** Only safe while every registration still has a holder profile (no QUICK tickets yet). */
export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.changeColumn("registration", "person_id", { type: DataTypes.UUID, allowNull: false }, { transaction });
    await queryInterface.removeColumn("registration", "currency", { transaction });
    await queryInterface.removeColumn("registration", "price_amount", { transaction });
    await queryInterface.removeColumn("registration", "order_id", { transaction });
  });
};
