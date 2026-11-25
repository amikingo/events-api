import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Phase 3d: what a stored file belongs to and who uploaded it, like bookings_api's files table.
 * - entity_type / entity_id: the record the file belongs to (for EVENT_COVER: the event). A logical reference with
 *   no foreign key, because later purposes may belong to other tables; event.cover_file_id keeps the real,
 *   tenant-safe foreign key.
 * - uploaded_by: the staff member's Central Auth user id (nullable, like created_by).
 * - storage_provider: where the bytes live ('local' disk today), so a bucket can be added later beside old files.
 *
 * Existing rows: only storage_provider is NOT NULL, and its default 'local' fills existing rows. The new check
 * requires every EVENT_COVER row to name its event, so if `file` already had rows (nothing could write it before
 * 3d) the migration would fail and roll back without changing anything. Check first: SELECT count(*) FROM file;
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.addColumn("file", "entity_type", { type: DataTypes.STRING(40), allowNull: true }, { transaction });
    await queryInterface.addColumn("file", "entity_id", { type: DataTypes.UUID, allowNull: true }, { transaction });
    await queryInterface.addColumn("file", "uploaded_by", { type: DataTypes.UUID, allowNull: true }, { transaction });
    await queryInterface.addColumn(
      "file",
      "storage_provider",
      { type: DataTypes.STRING(20), allowNull: false, defaultValue: "local" },
      { transaction },
    );
    await queryInterface.sequelize.query(
      `ALTER TABLE "file"
         ADD CONSTRAINT "ck_file_storage_provider" CHECK ("storage_provider" IN ('local')),
         ADD CONSTRAINT "ck_file_event_cover_entity"
           CHECK ("purpose" <> 'EVENT_COVER' OR ("entity_type" = 'EVENT' AND "entity_id" IS NOT NULL))`,
      { transaction },
    );
    await queryInterface.addIndex("file", ["organization_id", "entity_type", "entity_id"], { name: "idx_file_organization_entity", transaction });
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    // Dropping the columns drops their checks and the index with them.
    await queryInterface.removeColumn("file", "storage_provider", { transaction });
    await queryInterface.removeColumn("file", "uploaded_by", { transaction });
    await queryInterface.removeColumn("file", "entity_id", { transaction });
    await queryInterface.removeColumn("file", "entity_type", { transaction });
  });
};
