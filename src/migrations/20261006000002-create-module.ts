import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      "module",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: queryInterface.sequelize.fn("gen_random_uuid") },
        code: { type: DataTypes.STRING(80), allowNull: false },
        module_name: { type: DataTypes.STRING(250), allowNull: false },
        description: { type: DataTypes.TEXT, allowNull: true },
        parent_id: { type: DataTypes.UUID, allowNull: true },
        sno: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        icon: { type: DataTypes.STRING(250), allowNull: true },
        route_name: { type: DataTypes.STRING(250), allowNull: true },
        is_menu: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        is_permission: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        created_by: { type: DataTypes.UUID, allowNull: true },
        updated_by: { type: DataTypes.UUID, allowNull: true },
      },
      { transaction },
    );

    await queryInterface.addConstraint("module", {
      fields: ["parent_id"],
      type: "foreign key",
      name: "fk_module_parent_id",
      references: { table: "module", field: "id" },
      onUpdate: "CASCADE",
      onDelete: "SET NULL",
      transaction,
    });
    await queryInterface.addConstraint("module", { fields: ["code"], type: "unique", name: "uq_module_code", transaction });
    await queryInterface.sequelize.query(
      `ALTER TABLE "module"
         ADD CONSTRAINT "ck_module_code_format" CHECK ("code" ~ '^[A-Z0-9_]+$'),
         ADD CONSTRAINT "ck_module_parent_not_self" CHECK ("parent_id" IS NULL OR "parent_id" <> "id"),
         ADD CONSTRAINT "ck_module_sno_non_negative" CHECK ("sno" >= 0)`,
      { transaction },
    );
    await queryInterface.addIndex("module", ["parent_id", "sno"], { name: "idx_module_parent_id_sno", transaction });
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable("module", { transaction });
  });
};
