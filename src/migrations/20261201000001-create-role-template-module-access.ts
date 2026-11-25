import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/** Phase 2d: a role template's grants, the same shape as role_module_access. */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  const flag = () => ({ type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      "role_template_module_access",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: queryInterface.sequelize.fn("gen_random_uuid") },
        role_template_id: { type: DataTypes.UUID, allowNull: false },
        module_id: { type: DataTypes.UUID, allowNull: false },
        can_view: flag(),
        can_create: flag(),
        can_update: flag(),
        can_delete: flag(),
        can_import: flag(),
        can_export: flag(),
        can_notify: flag(),
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        created_by: { type: DataTypes.UUID, allowNull: true },
        updated_by: { type: DataTypes.UUID, allowNull: true },
      },
      { transaction },
    );
    await queryInterface.addConstraint("role_template_module_access", {
      fields: ["role_template_id"],
      type: "foreign key",
      name: "fk_role_template_module_access_role_template_id",
      references: { table: "role_template", field: "id" },
      onUpdate: "CASCADE",
      onDelete: "CASCADE",
      transaction,
    });
    await queryInterface.addConstraint("role_template_module_access", {
      fields: ["module_id"],
      type: "foreign key",
      name: "fk_role_template_module_access_module_id",
      references: { table: "module", field: "id" },
      onUpdate: "CASCADE",
      onDelete: "CASCADE",
      transaction,
    });
    await queryInterface.addConstraint("role_template_module_access", {
      fields: ["role_template_id", "module_id"],
      type: "unique",
      name: "uq_role_template_module_access_template_module",
      transaction,
    });
    await queryInterface.addIndex("role_template_module_access", ["module_id"], { name: "idx_role_template_module_access_module_id", transaction });
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable("role_template_module_access", { transaction });
  });
};
