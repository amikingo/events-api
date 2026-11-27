import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Venue map pins: where a venue is on a map, so the booking site can show the exact spot. At most one per venue; no
 * row means no pin (the site then shows the city). Kept in its own table, so no existing venue or event query depends
 * on this migration having run.
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      "venue_location",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: queryInterface.sequelize.fn("gen_random_uuid") },
        organization_id: { type: DataTypes.UUID, allowNull: false },
        venue_id: { type: DataTypes.UUID, allowNull: false },
        latitude: { type: DataTypes.DOUBLE, allowNull: false },
        longitude: { type: DataTypes.DOUBLE, allowNull: false },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        created_by: { type: DataTypes.UUID, allowNull: true },
        updated_by: { type: DataTypes.UUID, allowNull: true },
      },
      { transaction },
    );
    await queryInterface.sequelize.query(
      `ALTER TABLE "venue_location"
         ADD CONSTRAINT "uq_venue_location_organization_id_id" UNIQUE ("organization_id", "id"),
         ADD CONSTRAINT "uq_venue_location_organization_venue" UNIQUE ("organization_id", "venue_id"),
         ADD CONSTRAINT "fk_venue_location_venue" FOREIGN KEY ("organization_id", "venue_id")
           REFERENCES "venue" ("organization_id", "id") ON UPDATE CASCADE ON DELETE CASCADE,
         ADD CONSTRAINT "ck_venue_location_latitude" CHECK ("latitude" BETWEEN -90 AND 90),
         ADD CONSTRAINT "ck_venue_location_longitude" CHECK ("longitude" BETWEEN -180 AND 180)`,
      { transaction },
    );
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable("venue_location", { transaction });
  });
};
