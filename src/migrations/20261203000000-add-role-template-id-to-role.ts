import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Phase 2e step 3: a role remembers the template it was made from. Still a copy, never a link: the column only records
 * the origin, so the Super Admin can see which roles came from a template and Owners can filter by it. Templates are
 * never deleted; the foreign key sets the column to null if one ever is.
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.addColumn("role", "role_template_id", { type: DataTypes.UUID, allowNull: true }, { transaction });
    await queryInterface.addConstraint("role", {
      fields: ["role_template_id"],
      type: "foreign key",
      name: "fk_role_role_template_id",
      references: { table: "role_template", field: "id" },
      onUpdate: "CASCADE",
      onDelete: "SET NULL",
      transaction,
    });
    await queryInterface.addIndex("role", ["role_template_id"], { name: "idx_role_role_template_id", transaction });
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.removeColumn("role", "role_template_id", { transaction });
  });
};
