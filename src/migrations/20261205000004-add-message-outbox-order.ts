import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Phase 7 step 2: a message may now report an order (one SMS to the buyer listing the order's codes, kind
 * ORDER_CONFIRMATION) instead of one registration. Exactly one of registration_id and order_id is set.
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.addColumn("message_outbox", "order_id", { type: DataTypes.UUID, allowNull: true }, { transaction });
    await queryInterface.changeColumn("message_outbox", "registration_id", { type: DataTypes.UUID, allowNull: true }, { transaction });
    await queryInterface.sequelize.query(
      `ALTER TABLE "message_outbox"
         DROP CONSTRAINT "ck_message_outbox_kind",
         ADD CONSTRAINT "ck_message_outbox_kind" CHECK ("kind" IN ('REGISTRATION_CONFIRMATION', 'ORDER_CONFIRMATION')),
         ADD CONSTRAINT "fk_message_outbox_organization_order" FOREIGN KEY ("organization_id", "order_id")
           REFERENCES "ticket_order" ("organization_id", "id") ON UPDATE CASCADE ON DELETE RESTRICT,
         ADD CONSTRAINT "ck_message_outbox_one_subject" CHECK (("registration_id" IS NULL) <> ("order_id" IS NULL))`,
      { transaction },
    );
    await queryInterface.addIndex("message_outbox", ["organization_id", "order_id"], { name: "idx_message_outbox_order", transaction });
  });
};

/** Only safe while no order messages exist. */
export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(
      `ALTER TABLE "message_outbox"
         DROP CONSTRAINT "ck_message_outbox_one_subject",
         DROP CONSTRAINT "ck_message_outbox_kind",
         ADD CONSTRAINT "ck_message_outbox_kind" CHECK ("kind" IN ('REGISTRATION_CONFIRMATION'))`,
      { transaction },
    );
    await queryInterface.removeColumn("message_outbox", "order_id", { transaction });
    await queryInterface.changeColumn("message_outbox", "registration_id", { type: DataTypes.UUID, allowNull: false }, { transaction });
  });
};
