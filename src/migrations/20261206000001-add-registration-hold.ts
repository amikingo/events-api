import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Phase 7 step 3: a ticket of an order waiting for payment is HELD (it takes a place but has no code yet); when the
 * hold ends unpaid it is RELEASED. Codes are issued only when the payment is verified, so `code` may be empty for
 * HELD and RELEASED tickets only. Neither has a cancellation date.
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.changeColumn("registration", "code", { type: DataTypes.STRING(8), allowNull: true }, { transaction });
    await queryInterface.sequelize.query(
      `ALTER TABLE "registration"
         DROP CONSTRAINT "ck_registration_status",
         ADD CONSTRAINT "ck_registration_status" CHECK ("status" IN ('CONFIRMED', 'CANCELLED', 'HELD', 'RELEASED')),
         DROP CONSTRAINT "ck_registration_cancelled_at_status",
         ADD CONSTRAINT "ck_registration_cancelled_at_status" CHECK (
           ("status" = 'CANCELLED' AND "cancelled_at" IS NOT NULL) OR ("status" <> 'CANCELLED' AND "cancelled_at" IS NULL)),
         ADD CONSTRAINT "ck_registration_issued_has_code" CHECK ("status" IN ('HELD', 'RELEASED') OR "code" IS NOT NULL)`,
      { transaction },
    );
  });
};

/** Only safe while no ticket is HELD or RELEASED. */
export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(
      `ALTER TABLE "registration"
         DROP CONSTRAINT "ck_registration_issued_has_code",
         DROP CONSTRAINT "ck_registration_cancelled_at_status",
         ADD CONSTRAINT "ck_registration_cancelled_at_status" CHECK (
           ("status" = 'CONFIRMED' AND "cancelled_at" IS NULL) OR ("status" = 'CANCELLED' AND "cancelled_at" IS NOT NULL)),
         DROP CONSTRAINT "ck_registration_status",
         ADD CONSTRAINT "ck_registration_status" CHECK ("status" IN ('CONFIRMED', 'CANCELLED'))`,
      { transaction },
    );
    await queryInterface.changeColumn("registration", "code", { type: DataTypes.STRING(8), allowNull: false }, { transaction });
  });
};
