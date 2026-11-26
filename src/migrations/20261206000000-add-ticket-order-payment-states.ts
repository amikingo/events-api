import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Phase 7 step 3: an order with a price waits for payment.
 * - status: CONFIRMED (tickets issued), PENDING_PAYMENT (places held until hold_expires_at), EXPIRED (unpaid in
 *   time, places released), REFUND_REQUIRED (paid after its places were released and no room was left: kept for
 *   follow-up). As in bookings, a callback that isn't "Completed" changes nothing: the hold lapses on its own.
 * - hold_expires_at: when the held places of a PENDING_PAYMENT order are released.
 * - access_token_hash: SHA-256 of the random order token the buyer gets at checkout (to read the order and its codes
 *   without an account). Only the hash is stored.
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.addColumn("ticket_order", "hold_expires_at", { type: DataTypes.DATE, allowNull: true }, { transaction });
    await queryInterface.addColumn("ticket_order", "access_token_hash", { type: DataTypes.STRING(64), allowNull: true }, { transaction });
    await queryInterface.sequelize.query(
      `ALTER TABLE "ticket_order"
         DROP CONSTRAINT "ck_ticket_order_status",
         ADD CONSTRAINT "ck_ticket_order_status" CHECK ("status" IN ('CONFIRMED', 'PENDING_PAYMENT', 'EXPIRED', 'REFUND_REQUIRED')),
         ADD CONSTRAINT "ck_ticket_order_pending_has_expiry" CHECK ("status" <> 'PENDING_PAYMENT' OR "hold_expires_at" IS NOT NULL),
         ADD CONSTRAINT "ck_ticket_order_access_token_hash_format" CHECK ("access_token_hash" IS NULL OR "access_token_hash" ~ '^[0-9a-f]{64}$')`,
      { transaction },
    );
    await queryInterface.addIndex("ticket_order", ["status", "hold_expires_at"], { name: "idx_ticket_order_status_hold_expires", transaction });
  });
};

/** Only safe while no order has a payment state. */
export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(
      `ALTER TABLE "ticket_order"
         DROP CONSTRAINT "ck_ticket_order_access_token_hash_format",
         DROP CONSTRAINT "ck_ticket_order_pending_has_expiry",
         DROP CONSTRAINT "ck_ticket_order_status",
         ADD CONSTRAINT "ck_ticket_order_status" CHECK ("status" IN ('CONFIRMED'))`,
      { transaction },
    );
    await queryInterface.removeColumn("ticket_order", "access_token_hash", { transaction });
    await queryInterface.removeColumn("ticket_order", "hold_expires_at", { transaction });
  });
};
