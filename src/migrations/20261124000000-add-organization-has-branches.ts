import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Whether an organization shows branches to its staff. Every organization still gets a MAIN branch under the
 * hood; with has_branches = false its staff never see anything about branches. Organizations that already have
 * more than one branch keep seeing them.
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.addColumn(
      "organization",
      "has_branches",
      { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      { transaction },
    );
    await queryInterface.sequelize.query(
      `UPDATE "organization" o
          SET "has_branches" = true
        WHERE (SELECT count(*) FROM "branch" b WHERE b."organization_id" = o."id") > 1`,
      { transaction },
    );
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.removeColumn("organization", "has_branches", { transaction });
  });
};
