import type { QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Phase 9: EVENT_CANCELLATION, the refund due on one paid order when its event is cancelled. Like the other payment
 * kinds it is identified by the charge that paid the order (organization + tx_ref, uq_payment_case_attempt), so one
 * charge has one obligation however often the cancellation or a webhook is repeated.
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.query(
    `ALTER TABLE "payment_case"
       DROP CONSTRAINT "ck_payment_case_kind",
       ADD CONSTRAINT "ck_payment_case_kind" CHECK ("kind" IN ('REFUND_REQUIRED', 'PAID_TWICE', 'AMOUNT_MISMATCH', 'TICKET_RETURN', 'EVENT_CANCELLATION'))`,
  );
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.query(
    `ALTER TABLE "payment_case"
       DROP CONSTRAINT "ck_payment_case_kind",
       ADD CONSTRAINT "ck_payment_case_kind" CHECK ("kind" IN ('REFUND_REQUIRED', 'PAID_TWICE', 'AMOUNT_MISMATCH', 'TICKET_RETURN'))`,
  );
};
