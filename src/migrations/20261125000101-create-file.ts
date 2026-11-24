import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * file: tenant-scoped metadata for stored files (spec §5 cover_file_id). Only event covers for MVP 1. Uploading and
 * the storage provider arrive in Phase 3d, which may add columns; 3b only needs a row an event cover can reference.
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      "file",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: queryInterface.sequelize.fn("gen_random_uuid") },
        organization_id: { type: DataTypes.UUID, allowNull: false },
        purpose: { type: DataTypes.STRING(40), allowNull: false },
        storage_key: { type: DataTypes.STRING(500), allowNull: false },
        content_type: { type: DataTypes.STRING(100), allowNull: false },
        size_bytes: { type: DataTypes.INTEGER, allowNull: false },
        original_name: { type: DataTypes.STRING(255), allowNull: true },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        created_by: { type: DataTypes.UUID, allowNull: true },
        updated_by: { type: DataTypes.UUID, allowNull: true },
      },
      { transaction },
    );

    await queryInterface.addConstraint("file", {
      fields: ["organization_id"],
      type: "foreign key",
      name: "fk_file_organization_id",
      references: { table: "organization", field: "id" },
      onUpdate: "CASCADE",
      onDelete: "RESTRICT",
      transaction,
    });
    // Tenant-safe composite key: event.cover_file_id references (organization_id, id).
    await queryInterface.addConstraint("file", {
      fields: ["organization_id", "id"],
      type: "unique",
      name: "uq_file_organization_id_id",
      transaction,
    });
    await queryInterface.addConstraint("file", { fields: ["storage_key"], type: "unique", name: "uq_file_storage_key", transaction });
    await queryInterface.sequelize.query(
      `ALTER TABLE "file"
         ADD CONSTRAINT "ck_file_purpose" CHECK ("purpose" IN ('EVENT_COVER')),
         ADD CONSTRAINT "ck_file_size_positive" CHECK ("size_bytes" > 0)`,
      { transaction },
    );
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable("file", { transaction });
  });
};
