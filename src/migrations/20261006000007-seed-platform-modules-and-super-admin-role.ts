import type { QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Reference data the platform cannot run without. Deterministic UUIDs keep every
 * environment identical. Each later feature ships its own migration inserting its modules.
 */
const ADMINISTRATION_ID = "0b6f1d3e-0000-4000-8000-000000000001";
const ACCESS_CONTROL_ID = "0b6f1d3e-0000-4000-8000-000000000002";
const SUPER_ADMIN_ROLE_ID = "0b6f1d3e-0000-4000-8000-0000000000aa";

type ModuleSeed = {
  id: string;
  code: string;
  module_name: string;
  parent_id: string | null;
  sno: number;
  route_name: string | null;
  icon: string | null;
  is_menu: boolean;
  is_permission: boolean;
};

const MODULES: ModuleSeed[] = [
  // Navigation containers: never receive access rows.
  { id: ADMINISTRATION_ID, code: "ADMINISTRATION", module_name: "Administration", parent_id: null, sno: 10, route_name: null, icon: "Building2", is_menu: true, is_permission: false },
  { id: ACCESS_CONTROL_ID, code: "ACCESS_CONTROL", module_name: "Access Control", parent_id: null, sno: 20, route_name: null, icon: "ShieldCheck", is_menu: true, is_permission: false },
  // Permission-bearing modules (codes mirror utils/module-codes.ts).
  { id: "0b6f1d3e-0000-4000-8000-000000000011", code: "ORGANIZATIONS", module_name: "Organizations", parent_id: ADMINISTRATION_ID, sno: 1, route_name: "/organizations", icon: "Building", is_menu: true, is_permission: true },
  { id: "0b6f1d3e-0000-4000-8000-000000000012", code: "BRANCHES", module_name: "Branches", parent_id: ADMINISTRATION_ID, sno: 2, route_name: "/branches", icon: "GitBranch", is_menu: true, is_permission: true },
  { id: "0b6f1d3e-0000-4000-8000-000000000021", code: "MODULES", module_name: "Modules", parent_id: ACCESS_CONTROL_ID, sno: 1, route_name: "/access/modules", icon: "Boxes", is_menu: true, is_permission: true },
  { id: "0b6f1d3e-0000-4000-8000-000000000022", code: "ROLE_TEMPLATES", module_name: "Role Templates", parent_id: ACCESS_CONTROL_ID, sno: 2, route_name: "/access/role-templates", icon: "Copy", is_menu: true, is_permission: true },
  { id: "0b6f1d3e-0000-4000-8000-000000000023", code: "ROLES", module_name: "Roles", parent_id: ACCESS_CONTROL_ID, sno: 3, route_name: "/access/roles", icon: "KeyRound", is_menu: true, is_permission: true },
  { id: "0b6f1d3e-0000-4000-8000-000000000024", code: "USER_ROLES", module_name: "Staff Assignments", parent_id: ACCESS_CONTROL_ID, sno: 4, route_name: "/access/assignments", icon: "Users", is_menu: true, is_permission: true },
  { id: "0b6f1d3e-0000-4000-8000-000000000025", code: "USER_MODULE_ACCESSES", module_name: "Permission Overrides", parent_id: ACCESS_CONTROL_ID, sno: 5, route_name: "/access/overrides", icon: "SlidersHorizontal", is_menu: true, is_permission: true },
];

export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.bulkInsert(
      "module",
      MODULES.map((module) => ({ ...module, description: null, is_active: true })),
      { transaction },
    );
    await queryInterface.bulkInsert(
      "role",
      [{ id: SUPER_ADMIN_ROLE_ID, organization_id: null, code: "SUPER_ADMIN", name: "Super Admin", description: "Platform super administrator", is_active: true }],
      { transaction },
    );
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.bulkDelete("role", { id: SUPER_ADMIN_ROLE_ID }, { transaction });
    // Children first: parent FK is ON DELETE SET NULL, but delete deterministically anyway.
    await queryInterface.bulkDelete("module", { id: MODULES.filter((m) => m.parent_id).map((m) => m.id) }, { transaction });
    await queryInterface.bulkDelete("module", { id: MODULES.filter((m) => !m.parent_id).map((m) => m.id) }, { transaction });
  });
};
