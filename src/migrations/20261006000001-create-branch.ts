import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      "branch",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: queryInterface.sequelize.fn("gen_random_uuid") },
        organization_id: { type: DataTypes.UUID, allowNull: false },
        code: { type: DataTypes.STRING(80), allowNull: false },
        name: { type: DataTypes.STRING(255), allowNull: false },
        description: { type: DataTypes.TEXT, allowNull: true },
        is_default: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        created_by: { type: DataTypes.UUID, allowNull: true },
        updated_by: { type: DataTypes.UUID, allowNull: true },
      },
      { transaction },
    );

    await queryInterface.addConstraint("branch", {
      fields: ["organization_id"],
      type: "foreign key",
      name: "fk_branch_organization_id",
      references: { table: "organization", field: "id" },
      onUpdate: "CASCADE",
      onDelete: "RESTRICT",
      transaction,
    });

    // Tenant-safe composite key: children reference (organization_id, id), so a child row
    // can never point at another tenant's branch -- enforced by Postgres, not by code review.
    await queryInterface.addConstraint("branch", {
      fields: ["organization_id", "id"],
      type: "unique",
      name: "uq_branch_organization_id_id",
      transaction,
    });
    await queryInterface.addConstraint("branch", {
      fields: ["organization_id", "code"],
      type: "unique",
      name: "uq_branch_organization_id_code",
      transaction,
    });
    await queryInterface.sequelize.query(
      `ALTER TABLE "branch" ADD CONSTRAINT "ck_branch_code_format" CHECK ("code" ~ '^[A-Z0-9_]+$')`,
      { transaction },
    );
    // At most one active default branch per organization.
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX "uq_branch_organization_default_active"
         ON "branch" ("organization_id")
         WHERE "is_default" = true AND "is_active" = true`,
      { transaction },
    );
    await queryInterface.addIndex("branch", ["organization_id", "is_active"], {
      name: "idx_branch_organization_active",
      transaction,
    });
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable("branch", { transaction });
  });
};
