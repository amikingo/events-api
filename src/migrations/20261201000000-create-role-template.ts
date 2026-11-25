import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Phase 2d: role templates, a platform library the Super Admin edits. New organizations get their roles from the
 * active templates marked `for_new_organizations`; Owners can start a role from any active template. A role is a
 * copy: editing a template never changes an existing organization's roles.
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      "role_template",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: queryInterface.sequelize.fn("gen_random_uuid") },
        code: { type: DataTypes.STRING(80), allowNull: false },
        name: { type: DataTypes.STRING(250), allowNull: false },
        description: { type: DataTypes.TEXT, allowNull: true },
        is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        for_new_organizations: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        created_by: { type: DataTypes.UUID, allowNull: true },
        updated_by: { type: DataTypes.UUID, allowNull: true },
      },
      { transaction },
    );
    await queryInterface.sequelize.query(
      `ALTER TABLE "role_template" ADD CONSTRAINT "ck_role_template_code_format" CHECK ("code" ~ '^[A-Z0-9_]+$')`,
      { transaction },
    );
    await queryInterface.addConstraint("role_template", { fields: ["code"], type: "unique", name: "uq_role_template_code", transaction });
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable("role_template", { transaction });
  });
};
