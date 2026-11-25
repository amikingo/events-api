import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * person (spec §6): an organizer's reusable attendee profile. Each organizer keeps its own profiles; a matching
 * name, phone or email never links two of them. `user_id` (a Central Auth user, for attendees registering
 * themselves later) is unique per organization when present. Registrations reference (organization_id, id).
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      "person",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: queryInterface.sequelize.fn("gen_random_uuid") },
        organization_id: { type: DataTypes.UUID, allowNull: false },
        first_name: { type: DataTypes.STRING(100), allowNull: false },
        last_name: { type: DataTypes.STRING(100), allowNull: true },
        email: { type: DataTypes.STRING(254), allowNull: true },
        phone: { type: DataTypes.STRING(32), allowNull: true },
        affiliation_name: { type: DataTypes.STRING(200), allowNull: true },
        country: { type: DataTypes.STRING(2), allowNull: true },
        is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        user_id: { type: DataTypes.UUID, allowNull: true }, // Central Auth user id: logical reference, no FK
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        created_by: { type: DataTypes.UUID, allowNull: true },
        updated_by: { type: DataTypes.UUID, allowNull: true },
      },
      { transaction },
    );

    await queryInterface.addConstraint("person", {
      fields: ["organization_id"],
      type: "foreign key",
      name: "fk_person_organization_id",
      references: { table: "organization", field: "id" },
      onUpdate: "CASCADE",
      onDelete: "RESTRICT",
      transaction,
    });
    // Tenant-safe composite key: registration.person_id references (organization_id, id).
    await queryInterface.addConstraint("person", { fields: ["organization_id", "id"], type: "unique", name: "uq_person_organization_id_id", transaction });
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX "uq_person_organization_user_id" ON "person" ("organization_id", "user_id") WHERE "user_id" IS NOT NULL;
       ALTER TABLE "person" ADD CONSTRAINT "ck_person_country_format" CHECK ("country" IS NULL OR "country" ~ '^[A-Z]{2}$');
       CREATE INDEX "idx_person_organization_phone" ON "person" ("organization_id", "phone");
       CREATE INDEX "idx_person_organization_email" ON "person" ("organization_id", lower("email"));`,
      { transaction },
    );
    await queryInterface.addIndex("person", ["organization_id", "is_active"], { name: "idx_person_organization_active", transaction });
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable("person", { transaction });
  });
};
