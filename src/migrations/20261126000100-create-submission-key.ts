import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * submission_key (spec rule 4): the durable retry key of a registration request. The same Idempotency-Key with the
 * same request (request_hash) returns the original registration instead of creating another; the same key with a
 * different request is refused. Only successful registrations store a key. Supporting infrastructure outside the
 * eight business tables.
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      "submission_key",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: queryInterface.sequelize.fn("gen_random_uuid") },
        organization_id: { type: DataTypes.UUID, allowNull: false },
        scope: { type: DataTypes.STRING(40), allowNull: false },
        key: { type: DataTypes.STRING(128), allowNull: false },
        request_hash: { type: DataTypes.STRING(64), allowNull: false },
        registration_id: { type: DataTypes.UUID, allowNull: false },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
      },
      { transaction },
    );

    await queryInterface.addConstraint("submission_key", {
      fields: ["organization_id", "scope", "key"],
      type: "unique",
      name: "uq_submission_key_organization_scope_key",
      transaction,
    });
    await queryInterface.sequelize.query(
      `ALTER TABLE "submission_key"
         ADD CONSTRAINT "fk_submission_key_organization_registration" FOREIGN KEY ("organization_id", "registration_id")
           REFERENCES "registration" ("organization_id", "id") ON UPDATE CASCADE ON DELETE RESTRICT,
         ADD CONSTRAINT "ck_submission_key_scope" CHECK ("scope" IN ('PUBLIC_REGISTRATION', 'STAFF_REGISTRATION')),
         ADD CONSTRAINT "ck_submission_key_key_format" CHECK ("key" ~ '^[A-Za-z0-9_-]{8,128}$'),
         ADD CONSTRAINT "ck_submission_key_request_hash_format" CHECK ("request_hash" ~ '^[0-9a-f]{64}$')`,
      { transaction },
    );
    await queryInterface.addIndex("submission_key", ["organization_id", "registration_id"], {
      name: "idx_submission_key_registration",
      transaction,
    });
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable("submission_key", { transaction });
  });
};
