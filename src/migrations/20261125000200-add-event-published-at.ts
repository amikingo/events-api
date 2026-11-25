import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * event.published_at: when the event was first published. Server-managed (never accepted from clients), set once in
 * the transaction that first publishes the event, and preserved after it closes or is cancelled. Public direct links
 * resolve only events with a published_at (Phase 3c).
 *
 * Backfill. No publication time was recorded before this migration, so:
 * - PUBLISHED and CLOSED rows get `updated_at` as a fallback (the last recorded change, never earlier than the real
 *   first publication; exact when the event was not edited after publishing);
 * - CANCELLED rows stay NULL: their history does not prove they were ever published, so they stay private;
 * - DRAFT rows stay NULL.
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.addColumn("event", "published_at", { type: DataTypes.DATE, allowNull: true }, { transaction });
    await queryInterface.sequelize.query(
      `UPDATE "event" SET "published_at" = "updated_at" WHERE "status" IN ('PUBLISHED', 'CLOSED') AND "published_at" IS NULL`,
      { transaction },
    );
    // Backstop: a draft was never published; a published or closed event always was. A cancelled one may be either.
    await queryInterface.sequelize.query(
      `ALTER TABLE "event" ADD CONSTRAINT "ck_event_published_at_consistent" CHECK (
         ("status" = 'DRAFT' AND "published_at" IS NULL)
         OR ("status" IN ('PUBLISHED', 'CLOSED') AND "published_at" IS NOT NULL)
         OR "status" = 'CANCELLED'
       )`,
      { transaction },
    );
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    // Dropping the column drops its CHECK constraint with it.
    await queryInterface.removeColumn("event", "published_at", { transaction });
  });
};
