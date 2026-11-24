import type { QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Phase 3 permission modules and their menu: EVENTS (events, ticket types and venues) and CUSTOMERS (the clients
 * commissioning events, shown as "Clients"). REGISTRATIONS arrives with Phase 4. Deterministic UUIDs keep every
 * environment identical; codes mirror utils/module-codes.ts.
 */
const EVENT_MANAGEMENT_ID = "0b6f1d3e-0000-4000-8000-000000000003";

const MODULES = [
  // Navigation container: never receives access rows. Listed before Administration (sno 10).
  { id: EVENT_MANAGEMENT_ID, code: "EVENT_MANAGEMENT", module_name: "Event Management", parent_id: null, sno: 5, route_name: null, icon: "CalendarDays", is_menu: true, is_permission: false },
  { id: "0b6f1d3e-0000-4000-8000-000000000031", code: "EVENTS", module_name: "Events", parent_id: EVENT_MANAGEMENT_ID, sno: 1, route_name: "/events", icon: "Calendar", is_menu: true, is_permission: true },
  { id: "0b6f1d3e-0000-4000-8000-000000000032", code: "CUSTOMERS", module_name: "Clients", parent_id: EVENT_MANAGEMENT_ID, sno: 2, route_name: "/clients", icon: "Briefcase", is_menu: true, is_permission: true },
];

export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.bulkInsert(
      "module",
      MODULES.map((module) => ({ ...module, description: null, is_active: true })),
      { transaction },
    );
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.bulkDelete("module", { id: MODULES.filter((m) => m.parent_id).map((m) => m.id) }, { transaction });
    await queryInterface.bulkDelete("module", { id: [EVENT_MANAGEMENT_ID] }, { transaction });
  });
};
