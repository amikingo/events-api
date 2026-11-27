import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Phase 9: succeeded_at, when the payment actually succeeded, as Cheche Pay's merchant-verify reports it (null when it
 * doesn't say). It decides which side of a hold deadline or sales cutoff a payment fell on; verified_at stays the time
 * we verified it.
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.addColumn("order_payment", "succeeded_at", { type: DataTypes.DATE, allowNull: true });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.removeColumn("order_payment", "succeeded_at");
};
