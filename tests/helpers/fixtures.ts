import jwt from "jsonwebtoken";
import { authConfig } from "../../src/config/auth.js";
import type { BranchRow } from "../../src/models/branch.js";
import type { CustomerAccountRow } from "../../src/models/customer-account.js";
import type { EventRow } from "../../src/models/event.js";
import type { TicketTypeRow } from "../../src/models/ticket-type.js";
import type { VenueRow } from "../../src/models/venue.js";
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
  customerAccount: "88888888-8888-4888-8888-888888888881",
  venue: "99999999-9999-4999-8999-999999999991",
  event: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  ticketType: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
} as const;

const audit = {
  created_at: new Date("2026-01-01T00:00:00Z"),
  updated_at: new Date("2026-01-01T00:00:00Z"),
  created_by: null,
  updated_by: null,
};

export function organizationRow(overrides: Partial<OrganizationRow> = {}): OrganizationRow {
  // has_branches true: the shared fixtures model an organization that uses branches (the database default is false).
  return {
    id: IDS.orgA,
    name: "Org A",
    slug: "org-a",
    description: null,
    has_branches: true,
    country: "ET",
    timezone: "Africa/Addis_Ababa",
    default_currency: "ETB",
    is_active: true,
    ...audit,
    ...overrides,
  };
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

export function customerAccountRow(overrides: Partial<CustomerAccountRow> = {}): CustomerAccountRow {
  return {
    id: IDS.customerAccount,
    organization_id: IDS.orgA,
    name: "ABC Bank",
    kind: "ORGANIZATION",
    type: "Corporate",
    primary_contact_name: null,
    primary_contact_email: null,
    primary_contact_phone: null,
    is_active: true,
    ...audit,
    ...overrides,
  };
}

export function venueRow(overrides: Partial<VenueRow> = {}): VenueRow {
  return {
    id: IDS.venue,
    organization_id: IDS.orgA,
    name: "Millennium Hall",
    address: null,
    city: "Addis Ababa",
    country: "ET",
    capacity: 2000,
    is_active: true,
    ...audit,
    ...overrides,
  };
}

/** A ready-to-publish draft: dates set, organization-wide, no links. */
export function eventRow(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: IDS.event,
    organization_id: IDS.orgA,
    branch_id: null,
    customer_account_id: null,
    venue_id: null,
    cover_file_id: null,
    name: "Banking Forum",
    slug: "banking-forum",
    description: null,
    starts_at: new Date("2027-03-12T06:00:00Z"),
    ends_at: new Date("2027-03-12T14:00:00Z"),
    timezone: "Africa/Addis_Ababa",
    status: "DRAFT",
    capacity: null,
    registration_opens_at: null,
    registration_closes_at: null,
    visibility: "UNLISTED",
    category: null,
    ...audit,
    ...overrides,
  };
}

export function ticketTypeRow(overrides: Partial<TicketTypeRow> = {}): TicketTypeRow {
  return {
    id: IDS.ticketType,
    organization_id: IDS.orgA,
    event_id: IDS.event,
    code: "GA",
    name: "General Admission",
    capacity: null,
    display_order: 0,
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

const TEST_PROFILE = { mobile: "+251911000000", firstname: "Test", middlename: null, lastname: "User" };

export function staffToken(scope: { organizationId?: string | null; branchId?: string | null } = {}): string {
  return authTokenService.signAppStaffToken({
    userId: IDS.user,
    assignment: {
      id: IDS.assignment,
      role_id: IDS.roleA,
      organization_id: scope.organizationId === undefined ? IDS.orgA : scope.organizationId,
      branch_id: scope.branchId ?? null,
    },
    profile: TEST_PROFILE,
  }).token;
}

/** A Central Auth-style access token (HS256, iss auth_api, 3 days), as auth-cheche would issue it. */
export function centralAccessToken(): string {
  return jwt.sign({ user_id: IDS.user, token_type: "access", ...TEST_PROFILE }, authConfig.centralAuthJwtSecret, {
    algorithm: "HS256",
    expiresIn: 3 * 24 * 3600,
    issuer: authConfig.centralIssuer,
    subject: IDS.user,
  });
}
