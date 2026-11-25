import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * message_outbox (spec rule 5): a confirmation written in the same transaction as the registration it confirms,
 * delivered after commit by the outbox worker (Phase 4c), which can retry without allocating another seat.
 * Supporting infrastructure outside the eight business tables. `payload` holds what the message needs, so the text
 * is rendered at send time.
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      "message_outbox",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: queryInterface.sequelize.fn("gen_random_uuid") },
        organization_id: { type: DataTypes.UUID, allowNull: false },
        registration_id: { type: DataTypes.UUID, allowNull: false },
        kind: { type: DataTypes.STRING(40), allowNull: false },
        channel: { type: DataTypes.STRING(20), allowNull: false },
        recipient: { type: DataTypes.STRING(32), allowNull: false },
        payload: { type: DataTypes.JSONB, allowNull: false },
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "PENDING" },
        attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        next_attempt_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        last_error: { type: DataTypes.STRING(500), allowNull: true },
        sent_at: { type: DataTypes.DATE, allowNull: true },
        provider_message_id: { type: DataTypes.STRING(120), allowNull: true },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
      },
      { transaction },
    );

    await queryInterface.sequelize.query(
      `ALTER TABLE "message_outbox"
         ADD CONSTRAINT "fk_message_outbox_organization_registration" FOREIGN KEY ("organization_id", "registration_id")
           REFERENCES "registration" ("organization_id", "id") ON UPDATE CASCADE ON DELETE RESTRICT,
         ADD CONSTRAINT "ck_message_outbox_kind" CHECK ("kind" IN ('REGISTRATION_CONFIRMATION')),
         ADD CONSTRAINT "ck_message_outbox_channel" CHECK ("channel" IN ('SMS')),
         ADD CONSTRAINT "ck_message_outbox_status" CHECK ("status" IN ('PENDING', 'SENT', 'FAILED', 'SKIPPED')),
         ADD CONSTRAINT "ck_message_outbox_attempts_non_negative" CHECK ("attempts" >= 0),
         ADD CONSTRAINT "ck_message_outbox_sent_at_status" CHECK (("status" = 'SENT') = ("sent_at" IS NOT NULL));
       CREATE INDEX "idx_message_outbox_due" ON "message_outbox" ("next_attempt_at") WHERE "status" = 'PENDING';`,
      { transaction },
    );
    await queryInterface.addIndex("message_outbox", ["organization_id", "registration_id"], {
      name: "idx_message_outbox_registration",
      transaction,
    });
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable("message_outbox", { transaction });
  });
};
