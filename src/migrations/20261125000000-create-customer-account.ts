import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * customer_account: the client commissioning an event (spec §3), an organization or an individual. Not an
 * attendee (attendees are `person`, Phase 4). Tenant-owned, so events reference it through (organization_id, id).
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      "customer_account",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: queryInterface.sequelize.fn("gen_random_uuid") },
        organization_id: { type: DataTypes.UUID, allowNull: false },
        name: { type: DataTypes.STRING(255), allowNull: false },
        kind: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "ORGANIZATION" },
        type: { type: DataTypes.STRING(80), allowNull: true },
        primary_contact_name: { type: DataTypes.STRING(255), allowNull: true },
        primary_contact_email: { type: DataTypes.STRING(254), allowNull: true },
        primary_contact_phone: { type: DataTypes.STRING(32), allowNull: true },
        is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        created_by: { type: DataTypes.UUID, allowNull: true },
        updated_by: { type: DataTypes.UUID, allowNull: true },
      },
      { transaction },
    );

    await queryInterface.addConstraint("customer_account", {
      fields: ["organization_id"],
      type: "foreign key",
      name: "fk_customer_account_organization_id",
      references: { table: "organization", field: "id" },
      onUpdate: "CASCADE",
      onDelete: "RESTRICT",
      transaction,
    });
    // Tenant-safe composite key: event.customer_account_id references (organization_id, id).
    await queryInterface.addConstraint("customer_account", {
      fields: ["organization_id", "id"],
      type: "unique",
      name: "uq_customer_account_organization_id_id",
      transaction,
    });
    await queryInterface.sequelize.query(
      `ALTER TABLE "customer_account"
         ADD CONSTRAINT "ck_customer_account_kind" CHECK ("kind" IN ('ORGANIZATION', 'INDIVIDUAL')),
         ADD CONSTRAINT "ck_customer_account_type_organization_only" CHECK ("kind" = 'ORGANIZATION' OR "type" IS NULL)`,
      { transaction },
    );
    await queryInterface.addIndex("customer_account", ["organization_id", "is_active"], {
      name: "idx_customer_account_organization_active",
      transaction,
    });
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable("customer_account", { transaction });
  });
};
