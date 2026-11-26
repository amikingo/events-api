import type { QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Phase 8 step 3 permission module and its menu item: PAYMENTS (payment cases: refunds due, double charges and
 * mismatched amounts), shown as *Event Management › Payments* after Guests. Separate from Guests so door staff, who
 * hold Guests › update to check people in, can't record refunds. Deterministic UUID keeps every environment identical;
 * the code mirrors utils/module-codes.ts.
 */
const EVENT_MANAGEMENT_ID = "0b6f1d3e-0000-4000-8000-000000000003";
const PAYMENTS_ID = "0b6f1d3e-0000-4000-8000-000000000034";

export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.bulkInsert(
      "module",
      [
        {
          id: PAYMENTS_ID,
          code: "PAYMENTS",
          module_name: "Payments",
          parent_id: EVENT_MANAGEMENT_ID,
          sno: 4,
          route_name: "/payments",
          icon: "Wallet",
          is_menu: true,
          is_permission: true,
          description: null,
          is_active: true,
        },
      ],
      { transaction },
    );
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.bulkDelete("module", { id: [PAYMENTS_ID] }, { transaction });
  });
};
