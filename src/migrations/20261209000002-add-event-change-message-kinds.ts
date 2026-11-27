import type { QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/** Phase 9: the buyer SMS for an event cancelled (EVENT_CANCELLED) or rescheduled (EVENT_RESCHEDULED), one per order. */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.query(
    `ALTER TABLE "message_outbox"
       DROP CONSTRAINT "ck_message_outbox_kind",
       ADD CONSTRAINT "ck_message_outbox_kind" CHECK ("kind" IN ('REGISTRATION_CONFIRMATION', 'ORDER_CONFIRMATION', 'EVENT_CANCELLED', 'EVENT_RESCHEDULED'))`,
  );
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.query(
    `ALTER TABLE "message_outbox"
       DROP CONSTRAINT "ck_message_outbox_kind",
       ADD CONSTRAINT "ck_message_outbox_kind" CHECK ("kind" IN ('REGISTRATION_CONFIRMATION', 'ORDER_CONFIRMATION'))`,
  );
};
