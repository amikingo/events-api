import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      "role",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: queryInterface.sequelize.fn("gen_random_uuid") },
        organization_id: { type: DataTypes.UUID, allowNull: true }, // null = platform role
        code: { type: DataTypes.STRING(80), allowNull: false },
        name: { type: DataTypes.STRING(250), allowNull: false },
        description: { type: DataTypes.TEXT, allowNull: true },
        is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        created_by: { type: DataTypes.UUID, allowNull: true },
        updated_by: { type: DataTypes.UUID, allowNull: true },
      },
      { transaction },
    );

    await queryInterface.addConstraint("role", {
      fields: ["organization_id"],
      type: "foreign key",
      name: "fk_role_organization_id",
      references: { table: "organization", field: "id" },
      onUpdate: "CASCADE",
      onDelete: "RESTRICT",
      transaction,
    });
    await queryInterface.sequelize.query(
      `ALTER TABLE "role" ADD CONSTRAINT "ck_role_code_format" CHECK ("code" ~ '^[A-Z0-9_]+$')`,
      { transaction },
    );
    // Role codes are unique per tenant, and separately unique among platform roles.
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX "uq_role_organization_code" ON "role" ("organization_id", "code")
         WHERE "organization_id" IS NOT NULL`,
      { transaction },
    );
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX "uq_role_platform_code" ON "role" ("code") WHERE "organization_id" IS NULL`,
      { transaction },
    );
    await queryInterface.addIndex("role", ["organization_id", "is_active"], {
      name: "idx_role_organization_active",
      transaction,
    });
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable("role", { transaction });
  });
};
