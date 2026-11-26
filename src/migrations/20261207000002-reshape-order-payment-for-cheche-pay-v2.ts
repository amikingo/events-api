import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Phase 7 step 3b: order_payment for Cheche Pay v2 (transactions/initialize + merchant-verify), as bookings.
 * - Dropped (legacy only): payment_option_id, cheche_pay_service, provider_order_id.
 * - Renamed, keeping any data: vendor_ref → paid_tx_ref (the attempt that paid; unique once set),
 *   notify_time → verified_at (when merchant-verify confirmed it), last_notification → last_verification (the latest
 *   merchant-verify answer).
 * - Added: tx_ref (the latest attempt, `<payment id>-<suffix>`; v2 refuses a reused tx_ref, so each attempt gets a
 *   new one; unique once set), provider_transaction_id (Cheche Pay's transaction id), checkout_expires_at (when the
 *   checkout link stops working), key_mode (whether a test or live key took the payment).
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(
      `DROP INDEX IF EXISTS "idx_order_payment_provider_order_id";
       ALTER TABLE "order_payment" DROP CONSTRAINT IF EXISTS "ck_order_payment_paid_has_vendor_ref";
       ALTER TABLE "order_payment" DROP COLUMN "payment_option_id", DROP COLUMN "cheche_pay_service", DROP COLUMN "provider_order_id";
       ALTER TABLE "order_payment" RENAME COLUMN "vendor_ref" TO "paid_tx_ref";
       ALTER TABLE "order_payment" RENAME COLUMN "notify_time" TO "verified_at";
       ALTER TABLE "order_payment" RENAME COLUMN "last_notification" TO "last_verification";
       ALTER INDEX "uq_order_payment_vendor_ref" RENAME TO "uq_order_payment_paid_tx_ref";`,
      { transaction },
    );
    await queryInterface.addColumn("order_payment", "tx_ref", { type: DataTypes.STRING(100), allowNull: true }, { transaction });
    await queryInterface.addColumn("order_payment", "provider_transaction_id", { type: DataTypes.STRING(255), allowNull: true }, { transaction });
    await queryInterface.addColumn("order_payment", "checkout_expires_at", { type: DataTypes.DATE, allowNull: true }, { transaction });
    await queryInterface.addColumn("order_payment", "key_mode", { type: DataTypes.STRING(10), allowNull: true }, { transaction });
    await queryInterface.sequelize.query(
      `ALTER TABLE "order_payment"
         ADD CONSTRAINT "ck_order_payment_paid_verified" CHECK ("status" <> 'PAID' OR ("paid_tx_ref" IS NOT NULL AND "verified_at" IS NOT NULL)),
         ADD CONSTRAINT "ck_order_payment_key_mode" CHECK ("key_mode" IS NULL OR "key_mode" IN ('test', 'live'));
       CREATE UNIQUE INDEX "uq_order_payment_tx_ref" ON "order_payment" ("tx_ref") WHERE "tx_ref" IS NOT NULL;`,
      { transaction },
    );
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(
      `DROP INDEX IF EXISTS "uq_order_payment_tx_ref";
       ALTER TABLE "order_payment" DROP CONSTRAINT IF EXISTS "ck_order_payment_paid_verified", DROP CONSTRAINT IF EXISTS "ck_order_payment_key_mode";
       ALTER TABLE "order_payment" DROP COLUMN "tx_ref", DROP COLUMN "provider_transaction_id", DROP COLUMN "checkout_expires_at", DROP COLUMN "key_mode";
       ALTER INDEX "uq_order_payment_paid_tx_ref" RENAME TO "uq_order_payment_vendor_ref";
       ALTER TABLE "order_payment" RENAME COLUMN "last_verification" TO "last_notification";
       ALTER TABLE "order_payment" RENAME COLUMN "verified_at" TO "notify_time";
       ALTER TABLE "order_payment" RENAME COLUMN "paid_tx_ref" TO "vendor_ref";`,
      { transaction },
    );
    // The legacy columns come back; existing rows get placeholder values for the NOT NULL ones.
    await queryInterface.addColumn("order_payment", "payment_option_id", { type: DataTypes.STRING(100), allowNull: false, defaultValue: "UNKNOWN" }, { transaction });
    await queryInterface.addColumn("order_payment", "cheche_pay_service", { type: DataTypes.STRING(80), allowNull: false, defaultValue: "UNKNOWN" }, { transaction });
    await queryInterface.addColumn("order_payment", "provider_order_id", { type: DataTypes.STRING(255), allowNull: true }, { transaction });
    await queryInterface.sequelize.query(
      `ALTER TABLE "order_payment" ALTER COLUMN "payment_option_id" DROP DEFAULT, ALTER COLUMN "cheche_pay_service" DROP DEFAULT;
       ALTER TABLE "order_payment"
         ADD CONSTRAINT "ck_order_payment_paid_has_vendor_ref" CHECK ("status" <> 'PAID' OR ("vendor_ref" IS NOT NULL AND "notify_time" IS NOT NULL));
       CREATE INDEX "idx_order_payment_provider_order_id" ON "order_payment" ("provider_order_id") WHERE "provider_order_id" IS NOT NULL;`,
      { transaction },
    );
  });
};
