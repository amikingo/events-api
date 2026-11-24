import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  const override = () => ({ type: DataTypes.BOOLEAN, allowNull: true }); // null = inherit from role
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      "user_module_access",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: queryInterface.sequelize.fn("gen_random_uuid") },
        user_role_id: { type: DataTypes.UUID, allowNull: false },
        module_id: { type: DataTypes.UUID, allowNull: false },
        can_view: override(),
        can_create: override(),
        can_update: override(),
        can_delete: override(),
        can_import: override(),
        can_export: override(),
        can_notify: override(),
        is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        created_by: { type: DataTypes.UUID, allowNull: true },
        updated_by: { type: DataTypes.UUID, allowNull: true },
      },
      { transaction },
    );

    await queryInterface.addConstraint("user_module_access", {
      fields: ["user_role_id"],
      type: "foreign key",
      name: "fk_user_module_access_user_role_id",
      references: { table: "user_role", field: "id" },
      onUpdate: "CASCADE",
      onDelete: "CASCADE",
      transaction,
    });
    await queryInterface.addConstraint("user_module_access", {
      fields: ["module_id"],
      type: "foreign key",
      name: "fk_user_module_access_module_id",
      references: { table: "module", field: "id" },
      onUpdate: "CASCADE",
      onDelete: "CASCADE",
      transaction,
    });
    await queryInterface.addConstraint("user_module_access", {
      fields: ["user_role_id", "module_id"],
      type: "unique",
      name: "uq_user_module_access_user_role_id_module_id",
      transaction,
    });
    await queryInterface.sequelize.query(
      `ALTER TABLE "user_module_access" ADD CONSTRAINT "ck_user_module_access_has_override"
         CHECK (num_nonnulls("can_view", "can_create", "can_update", "can_delete",
                             "can_import", "can_export", "can_notify") > 0)`,
      { transaction },
    );
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable("user_module_access", { transaction });
  });
};
