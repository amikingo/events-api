import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Phase 9: event changes after sales.
 * - doors_open_at: when admission starts (empty means at starts_at); admission ends at ends_at. Before ends_at.
 * - cancelled_at, cancelled_by: when and by whom the event was cancelled; set exactly when the status is CANCELLED.
 *   Events cancelled before this migration get their last update time.
 * - refund_admitted_tickets: the organizer's decision, when cancelling an event that already admitted guests, whether
 *   used paid tickets are refunded too (null when there was nothing to decide).
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.addColumn("event", "doors_open_at", { type: DataTypes.DATE, allowNull: true }, { transaction });
    await queryInterface.addColumn("event", "cancelled_at", { type: DataTypes.DATE, allowNull: true }, { transaction });
    await queryInterface.addColumn("event", "cancelled_by", { type: DataTypes.UUID, allowNull: true }, { transaction });
    await queryInterface.addColumn("event", "refund_admitted_tickets", { type: DataTypes.BOOLEAN, allowNull: true }, { transaction });
    await queryInterface.sequelize.query(`UPDATE "event" SET "cancelled_at" = "updated_at" WHERE "status" = 'CANCELLED'`, { transaction });
    await queryInterface.sequelize.query(
      `ALTER TABLE "event"
         ADD CONSTRAINT "ck_event_doors_before_end" CHECK ("doors_open_at" IS NULL OR "ends_at" IS NULL OR "doors_open_at" < "ends_at"),
         ADD CONSTRAINT "ck_event_cancelled_at_status" CHECK (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL))`,
      { transaction },
    );
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(`ALTER TABLE "event" DROP CONSTRAINT IF EXISTS "ck_event_doors_before_end", DROP CONSTRAINT IF EXISTS "ck_event_cancelled_at_status"`, { transaction });
    for (const column of ["refund_admitted_tickets", "cancelled_by", "cancelled_at", "doors_open_at"]) {
      await queryInterface.removeColumn("event", column, { transaction });
    }
  });
};
