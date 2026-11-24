import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * venue: a reusable physical location (spec §4). venue.capacity describes the place; event.capacity (Phase 3b)
 * sets the booking limit for one event there. Tenant-owned, so events reference it through (organization_id, id).
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      "venue",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: queryInterface.sequelize.fn("gen_random_uuid") },
        organization_id: { type: DataTypes.UUID, allowNull: false },
        name: { type: DataTypes.STRING(255), allowNull: false },
        address: { type: DataTypes.STRING(500), allowNull: true },
        city: { type: DataTypes.STRING(120), allowNull: true },
        country: { type: DataTypes.STRING(2), allowNull: true },
        capacity: { type: DataTypes.INTEGER, allowNull: true },
        is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        created_by: { type: DataTypes.UUID, allowNull: true },
        updated_by: { type: DataTypes.UUID, allowNull: true },
      },
      { transaction },
    );

    await queryInterface.addConstraint("venue", {
      fields: ["organization_id"],
      type: "foreign key",
      name: "fk_venue_organization_id",
      references: { table: "organization", field: "id" },
      onUpdate: "CASCADE",
      onDelete: "RESTRICT",
      transaction,
    });
    // Tenant-safe composite key: event.venue_id references (organization_id, id).
    await queryInterface.addConstraint("venue", {
      fields: ["organization_id", "id"],
      type: "unique",
      name: "uq_venue_organization_id_id",
      transaction,
    });
    await queryInterface.sequelize.query(
      `ALTER TABLE "venue"
         ADD CONSTRAINT "ck_venue_capacity_positive" CHECK ("capacity" IS NULL OR "capacity" > 0),
         ADD CONSTRAINT "ck_venue_country_format" CHECK ("country" IS NULL OR "country" ~ '^[A-Z]{2}$')`,
      { transaction },
    );
    await queryInterface.addIndex("venue", ["organization_id", "is_active"], { name: "idx_venue_organization_active", transaction });
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable("venue", { transaction });
  });
};
