import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * registration (spec §8): one known guest's place at one event. One row per (organization_id, event_id, person_id):
 * cancelling frees the place, and registering the same person again reactivates the row. Only CONFIRMED rows
 * consume capacity. The ticket type is referenced through (organization_id, event_id, ticket_type_id), so a ticket
 * type of another event is rejected (spec rule 2). `code` is random and unique across the platform.
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      "registration",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: queryInterface.sequelize.fn("gen_random_uuid") },
        organization_id: { type: DataTypes.UUID, allowNull: false },
        event_id: { type: DataTypes.UUID, allowNull: false },
        person_id: { type: DataTypes.UUID, allowNull: false },
        ticket_type_id: { type: DataTypes.UUID, allowNull: false },
        status: { type: DataTypes.STRING(20), allowNull: false },
        source: { type: DataTypes.STRING(20), allowNull: false },
        registered_by: { type: DataTypes.UUID, allowNull: true }, // the staff member (Central Auth user id); empty for PUBLIC
        registered_at: { type: DataTypes.DATE, allowNull: false },
        cancelled_at: { type: DataTypes.DATE, allowNull: true },
        code: { type: DataTypes.STRING(8), allowNull: false },
        // Privacy-notice and consent evidence (public form only; a staff entry is never consent).
        privacy_notice_version: { type: DataTypes.STRING(40), allowNull: true },
        privacy_notice_shown_at: { type: DataTypes.DATE, allowNull: true },
        consent_purpose: { type: DataTypes.STRING(80), allowNull: true },
        consent_version: { type: DataTypes.STRING(40), allowNull: true },
        consented_at: { type: DataTypes.DATE, allowNull: true },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        created_by: { type: DataTypes.UUID, allowNull: true },
        updated_by: { type: DataTypes.UUID, allowNull: true },
      },
      { transaction },
    );

    await queryInterface.sequelize.query(
      `ALTER TABLE "registration"
         ADD CONSTRAINT "fk_registration_organization_event" FOREIGN KEY ("organization_id", "event_id")
           REFERENCES "event" ("organization_id", "id") ON UPDATE CASCADE ON DELETE RESTRICT,
         ADD CONSTRAINT "fk_registration_organization_person" FOREIGN KEY ("organization_id", "person_id")
           REFERENCES "person" ("organization_id", "id") ON UPDATE CASCADE ON DELETE RESTRICT,
         ADD CONSTRAINT "fk_registration_organization_event_ticket_type" FOREIGN KEY ("organization_id", "event_id", "ticket_type_id")
           REFERENCES "ticket_type" ("organization_id", "event_id", "id") ON UPDATE CASCADE ON DELETE RESTRICT`,
      { transaction },
    );
    await queryInterface.addConstraint("registration", {
      fields: ["organization_id", "event_id", "person_id"],
      type: "unique",
      name: "uq_registration_organization_event_person",
      transaction,
    });
    await queryInterface.addConstraint("registration", { fields: ["code"], type: "unique", name: "uq_registration_code", transaction });
    // Tenant-safe composite key for message_outbox and submission_key.
    await queryInterface.addConstraint("registration", {
      fields: ["organization_id", "id"],
      type: "unique",
      name: "uq_registration_organization_id_id",
      transaction,
    });
    await queryInterface.sequelize.query(
      `ALTER TABLE "registration"
         ADD CONSTRAINT "ck_registration_status" CHECK ("status" IN ('CONFIRMED', 'CANCELLED')),
         ADD CONSTRAINT "ck_registration_source" CHECK ("source" IN ('STAFF', 'PUBLIC')),
         ADD CONSTRAINT "ck_registration_registered_by_source" CHECK (
           ("source" = 'STAFF' AND "registered_by" IS NOT NULL) OR ("source" = 'PUBLIC' AND "registered_by" IS NULL)),
         ADD CONSTRAINT "ck_registration_cancelled_at_status" CHECK (
           ("status" = 'CONFIRMED' AND "cancelled_at" IS NULL) OR ("status" = 'CANCELLED' AND "cancelled_at" IS NOT NULL)),
         ADD CONSTRAINT "ck_registration_privacy_notice_pair" CHECK (
           ("privacy_notice_version" IS NULL) = ("privacy_notice_shown_at" IS NULL)),
         ADD CONSTRAINT "ck_registration_consent_triple" CHECK (
           ("consent_purpose" IS NULL AND "consent_version" IS NULL AND "consented_at" IS NULL)
           OR ("consent_purpose" IS NOT NULL AND "consent_version" IS NOT NULL AND "consented_at" IS NOT NULL)),
         ADD CONSTRAINT "ck_registration_code_format" CHECK ("code" ~ '^[A-HJKMNP-Z2-9]{8}$')`,
      { transaction },
    );
    await queryInterface.addIndex("registration", ["organization_id", "event_id", "status"], { name: "idx_registration_event_status", transaction });
    await queryInterface.addIndex("registration", ["organization_id", "ticket_type_id", "status"], {
      name: "idx_registration_ticket_type_status",
      transaction,
    });
    await queryInterface.addIndex("registration", ["organization_id", "person_id"], { name: "idx_registration_person", transaction });
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable("registration", { transaction });
  });
};
