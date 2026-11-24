import type { BranchRow } from "../../src/models/branch.js";
import type { ModuleRow } from "../../src/models/module.js";
import type { OrganizationRow } from "../../src/models/organization.js";
import type { RoleRow } from "../../src/models/role.js";
import type { AssignmentRow } from "../../src/repositories/user-role.repository.js";
import { authTokenService } from "../../src/services/auth-token.service.js";

export const IDS = {
  orgA: "11111111-1111-4111-8111-111111111111",
  orgB: "22222222-2222-4222-8222-222222222222",
  branchA1: "33333333-3333-4333-8333-333333333331",
  branchA2: "33333333-3333-4333-8333-333333333332",
  user: "44444444-4444-4444-8444-444444444444",
  roleA: "55555555-5555-4555-8555-555555555551",
  rolePlatform: "55555555-5555-4555-8555-555555555559",
  assignment: "66666666-6666-4666-8666-666666666661",
  module: "77777777-7777-4777-8777-777777777771",
} as const;

const audit = {
  created_at: new Date("2026-01-01T00:00:00Z"),
  updated_at: new Date("2026-01-01T00:00:00Z"),
  created_by: null,
  updated_by: null,
};

export function organizationRow(overrides: Partial<OrganizationRow> = {}): OrganizationRow {
  return { id: IDS.orgA, name: "Org A", slug: "org-a", description: null, is_active: true, ...audit, ...overrides };
}

export function branchRow(overrides: Partial<BranchRow> = {}): BranchRow {
  return {
    id: IDS.branchA1,
    organization_id: IDS.orgA,
    code: "MAIN",
    name: "Main",
    description: null,
    is_default: true,
    is_active: true,
    ...audit,
    ...overrides,
  };
}

export function roleRow(overrides: Partial<RoleRow> = {}): RoleRow {
  return { id: IDS.roleA, organization_id: IDS.orgA, code: "MANAGER", name: "Manager", description: null, is_active: true, ...audit, ...overrides };
}

export function moduleRow(overrides: Partial<ModuleRow> = {}): ModuleRow {
  return {
    id: IDS.module,
    code: "BRANCHES",
    module_name: "Branches",
    description: null,
    parent_id: null,
    sno: 1,
    icon: null,
    route_name: "/branches",
    is_menu: true,
    is_permission: true,
    is_active: true,
    ...audit,
    ...overrides,
  };
}

export function assignment(overrides: Partial<AssignmentRow> = {}): AssignmentRow {
  return {
    id: IDS.assignment,
    user_id: IDS.user,
    role_id: IDS.roleA,
    organization_id: IDS.orgA,
    branch_id: null,
    is_active: true,
    ...audit,
    role: roleRow(),
    organization: organizationRow(),
    branch: null,
    ...overrides,
  };
}

export function platformSuperAdmin(): AssignmentRow {
  return assignment({
    id: "66666666-6666-4666-8666-666666666669",
    role_id: IDS.rolePlatform,
    organization_id: null,
    role: roleRow({ id: IDS.rolePlatform, organization_id: null, code: "SUPER_ADMIN", name: "Super Admin" }),
    organization: null,
  });
}

export function staffToken(scope: { organizationId?: string | null; branchId?: string | null } = {}): string {
  return authTokenService.signAppStaffToken({
    userId: IDS.user,
    assignment: {
      id: IDS.assignment,
      role_id: IDS.roleA,
      organization_id: scope.organizationId === undefined ? IDS.orgA : scope.organizationId,
      branch_id: scope.branchId ?? null,
    },
    profile: { mobile: "+251911000000", firstname: "Test", middlename: null, lastname: "User" },
  }).token;
}
