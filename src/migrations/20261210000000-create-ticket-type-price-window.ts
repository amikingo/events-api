import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Phase 11: purchase-time pricing. A ticket type may have one-off price windows; inside a window a new order pays its
 * exact price, outside all windows the ticket type's regular price. Each window belongs to exactly one ticket type of
 * the same event and organization (composite key onto ticket_type's UNIQUE (organization_id, event_id, id)).
 * - starts_at is included and ends_at excluded; ends_at NULL means the price lasts until staff change the schedule.
 * - The price is NUMERIC(12,2) in the ticket type's currency; 0 is free.
 * - Overlaps between windows of one type are refused by the service under the event and ticket-type locks (decided
 *   27 November 2026: no database extension), so a schedule edit and a checkout never interleave.
 * Orders keep the prices they were checked out at (registration.price_amount), so editing a window never changes them.
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      "ticket_type_price_window",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: queryInterface.sequelize.fn("gen_random_uuid") },
        organization_id: { type: DataTypes.UUID, allowNull: false },
        event_id: { type: DataTypes.UUID, allowNull: false },
        ticket_type_id: { type: DataTypes.UUID, allowNull: false },
        starts_at: { type: DataTypes.DATE, allowNull: false },
        ends_at: { type: DataTypes.DATE, allowNull: true },
        price: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        created_by: { type: DataTypes.UUID, allowNull: true },
      },
      { transaction },
    );
    await queryInterface.sequelize.query(
      `ALTER TABLE "ticket_type_price_window"
         ADD CONSTRAINT "fk_ticket_type_price_window_ticket_type" FOREIGN KEY ("organization_id", "event_id", "ticket_type_id")
           REFERENCES "ticket_type" ("organization_id", "event_id", "id") ON UPDATE CASCADE ON DELETE CASCADE,
         ADD CONSTRAINT "ck_ticket_type_price_window_price" CHECK ("price" >= 0),
         ADD CONSTRAINT "ck_ticket_type_price_window_range" CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at")`,
      { transaction },
    );
    await queryInterface.addIndex("ticket_type_price_window", ["organization_id", "event_id", "ticket_type_id", "starts_at"], {
      name: "idx_ticket_type_price_window_type_start",
      transaction,
    });
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable("ticket_type_price_window", { transaction });
  });
};
