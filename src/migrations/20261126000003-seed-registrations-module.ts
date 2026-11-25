import type { QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Phase 4 permission module and its menu item: REGISTRATIONS (guest profiles and registrations), shown as
 * *Event Management › Guests* after Events and Clients. Deterministic UUID keeps every environment identical; the
 * code mirrors utils/module-codes.ts.
 */
const EVENT_MANAGEMENT_ID = "0b6f1d3e-0000-4000-8000-000000000003";
const REGISTRATIONS_ID = "0b6f1d3e-0000-4000-8000-000000000033";

export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.bulkInsert(
      "module",
      [
        {
          id: REGISTRATIONS_ID,
          code: "REGISTRATIONS",
          module_name: "Guests",
          parent_id: EVENT_MANAGEMENT_ID,
          sno: 3,
          route_name: "/guests",
          icon: "Users",
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
    await queryInterface.bulkDelete("module", { id: [REGISTRATIONS_ID] }, { transaction });
  });
};
