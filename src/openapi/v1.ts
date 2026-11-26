import { z } from "zod";
import { APP_TITLE, CUSTOMER_REFRESH_COOKIE, STAFF_REFRESH_COOKIE } from "../config/app.js";
import type { RequestContract } from "../middleware/validate.js";
import * as auth from "../validators/auth.js";
import * as branch from "../validators/branch.js";
import * as customer from "../validators/customer.js";
import * as customerAuth from "../validators/customer-auth.js";
import * as customerAccount from "../validators/customer-account.js";
import * as event from "../validators/event.js";
import * as moduleValidators from "../validators/module.js";
import * as organization from "../validators/organization.js";
import * as person from "../validators/person.js";
import * as platform from "../validators/platform.js";
import * as publicEvent from "../validators/public-event.js";
import * as publicRegistration from "../validators/public-registration.js";
import * as registration from "../validators/registration.js";
import * as role from "../validators/role.js";
import * as roleTemplate from "../validators/role-template.js";
import * as staffAssignment from "../validators/staff-assignment.js";
import * as ticketType from "../validators/ticket-type.js";
import * as venue from "../validators/venue.js";

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export type ApiOperation = {
  method: HttpMethod;
  /** OpenAPI path syntax, full path including the version prefix. */
  path: string;
  /** The exact contract object passed to validate() on the route (identity is checked by tests). */
  contract: RequestContract;
  /** components/schemas name for the body. Required exactly when contract.body exists. */
  bodyComponent?: string;
  /** A multipart/form-data upload of one file in this field (parsed by multer on the route, not by validate()). */
  fileUpload?: { field: string; description: string };
  summary: string;
  description?: string;
  tags: string[];
  /** customer: a guest's Cheche access token (Phase 6); customer-optional: public, personalized when one is sent. */
  auth: "staff" | "refresh-cookie" | "customer-refresh-cookie" | "customer" | "customer-optional" | "public";
  successStatus: 200 | 201 | 204;
  /** A success reply that is a file rather than the JSON envelope (the guest list export). Errors stay JSON. */
  successContent?: "text/csv";
};

/** The v1 operation list: one entry per route. A route without an entry fails tests/openapi.test.ts. */
export const v1Operations: readonly ApiOperation[] = [
  // --- Auth ---------------------------------------------------------------------------------
  { method: "post", path: "/v1/auth/staff/login", contract: auth.staffLoginRequest, bodyComponent: "StaffLoginRequest", summary: "Staff login with mobile or email + password (sets the HttpOnly refresh cookie)", tags: ["Auth"], auth: "public", successStatus: 200 },
  { method: "post", path: "/v1/auth/staff/refresh", contract: auth.staffRefreshRequest, bodyComponent: "StaffRefreshRequest", summary: "Renew the staff access token from the refresh cookie", tags: ["Auth"], auth: "refresh-cookie", successStatus: 200 },
  { method: "post", path: "/v1/auth/staff/logout", contract: auth.staffLogoutRequest, summary: "Sign out: clear the refresh cookie and revoke the Central Auth session (best effort; data.revoked says whether Central confirmed)", tags: ["Auth"], auth: "refresh-cookie", successStatus: 200 },
  { method: "get", path: "/v1/auth/staff/me", contract: auth.currentStaffSessionRequest, summary: "Current staff session: assignment, flat permissions, nested navigation", tags: ["Auth"], auth: "staff", successStatus: 200 },
  { method: "post", path: "/v1/auth/staff/switch-assignment", contract: auth.staffSwitchAssignmentRequest, bodyComponent: "StaffSwitchAssignmentRequest", summary: "Re-issue the staff token for another active assignment", tags: ["Auth"], auth: "staff", successStatus: 200 },

  // --- Guest accounts (Phase 6): Cheche accounts on the public site ---------------------------------------
  { method: "post", path: "/v1/auth/customer/signup", contract: customerAuth.customerSignUpRequest, bodyComponent: "CustomerSignUpRequest", summary: "Create a Cheche account (unconfirmed); auth-cheche sends a code by SMS", description: "Errors: 409 account_exists (sign in instead); 400 validation_error, with auth-cheche's text when it refused the details; 429 rate_limited (10 a minute per IP, 3 codes every 10 minutes per mobile); 429 central_auth_rate_limited; 503 central_auth_unavailable.", tags: ["Guest accounts"], auth: "public", successStatus: 201 },
  { method: "post", path: "/v1/auth/customer/signup/confirm", contract: customerAuth.customerConfirmSignUpRequest, bodyComponent: "CustomerConfirmSignUpRequest", summary: "Confirm the new account with the SMS code and sign in (the password is sent again); sets the HttpOnly refresh cookie", description: "Errors: 400 invalid_code; 404 account_not_found; 401 invalid_credentials (wrong password).", tags: ["Guest accounts"], auth: "public", successStatus: 200 },
  { method: "post", path: "/v1/auth/customer/signup/resend", contract: customerAuth.customerResendSignUpCodeRequest, bodyComponent: "CustomerSendCodeRequest", summary: "Send a new code for an unconfirmed sign-up", description: "auth-cheche's refusal text is shown as it is. Errors: 404 account_not_found; 429 rate_limited (3 every 10 minutes per mobile); 429 central_auth_rate_limited.", tags: ["Guest accounts"], auth: "public", successStatus: 200 },
  { method: "post", path: "/v1/auth/customer/code", contract: customerAuth.customerSendCodeRequest, bodyComponent: "CustomerSendCodeRequest", summary: "Send a sign-in code by SMS", description: "Errors: 404 account_not_found (offer sign-up); 429 rate_limited (3 every 10 minutes per mobile); 429 central_auth_rate_limited.", tags: ["Guest accounts"], auth: "public", successStatus: 200 },
  { method: "post", path: "/v1/auth/customer/login/code", contract: customerAuth.customerCodeLoginRequest, bodyComponent: "CustomerCodeLoginRequest", summary: "Sign in with the SMS code; sets the HttpOnly refresh cookie", description: "Errors: 400 invalid_code; 404 account_not_found.", tags: ["Guest accounts"], auth: "public", successStatus: 200 },
  { method: "post", path: "/v1/auth/customer/login/password", contract: customerAuth.customerPasswordLoginRequest, bodyComponent: "CustomerPasswordLoginRequest", summary: "Sign in with mobile and password; sets the HttpOnly refresh cookie", description: "Errors: 401 invalid_credentials (one fixed text for every refusal).", tags: ["Guest accounts"], auth: "public", successStatus: 200 },
  { method: "post", path: "/v1/auth/customer/refresh", contract: customerAuth.customerRefreshRequest, summary: "Renew the guest's access token from the refresh cookie (asks auth-cheche every time)", tags: ["Guest accounts"], auth: "customer-refresh-cookie", successStatus: 200 },
  { method: "post", path: "/v1/auth/customer/logout", contract: customerAuth.customerLogoutRequest, summary: "Sign out: clear the refresh cookie and revoke the session in auth-cheche (best effort)", tags: ["Guest accounts"], auth: "customer-refresh-cookie", successStatus: 200 },
  { method: "get", path: "/v1/auth/customer/me", contract: customerAuth.currentCustomerRequest, summary: "The signed-in guest: id, names and the account's mobile", tags: ["Guest accounts"], auth: "customer", successStatus: 200 },
  { method: "get", path: "/v1/customer/registrations", contract: customer.listMyTicketsRequest, summary: "My Tickets: the guest's own registrations across organizers, upcoming first (only those made while signed in)", tags: ["Guest accounts"], auth: "customer", successStatus: 200 },

  // --- Organizations --------------------------------------------------------------------------
  { method: "post", path: "/v1/organizations", contract: organization.createOrganizationRequest, bodyComponent: "OrganizationCreateRequest", summary: "Create a tenant (platform scope) with its OWNER and VIEWER roles. A hidden MAIN branch is always created; has_branches (default false) decides whether its staff see branches. Optional owner_mobile adds the first Owner in the same step", description: "Errors: 404 central_account_not_found (no Cheche account uses owner_mobile); 409 conflict (field slug, or field user_id when that person is already staff anywhere); 503 when auth-cheche can't be reached. A refusal creates nothing.", tags: ["Organizations"], auth: "staff", successStatus: 201 },
  { method: "get", path: "/v1/organizations", contract: organization.listOrganizationsRequest, summary: "List tenants (platform scope)", tags: ["Organizations"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}", contract: organization.updateOrganizationSettingsRequest, bodyComponent: "OrganizationSettingsUpdateRequest", summary: "Edit the organization's name, description and defaults (country, timezone, default_currency). The slug never changes. Existing events keep their own timezone", tags: ["Organizations"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}/status", contract: organization.changeOrganizationStatusRequest, bodyComponent: "StatusChangeRequest", summary: "Switch a tenant off or back on (platform Super Admin only). Switched off, its staff can't act (organization_inactive) and its events leave the catalog; nothing is deleted", tags: ["Organizations"], auth: "staff", successStatus: 200 },
  { method: "get", path: "/v1/organizations/{organizationId}", contract: organization.getOrganizationRequest, summary: "Read one tenant", tags: ["Organizations"], auth: "staff", successStatus: 200 },

  // --- Branches -------------------------------------------------------------------------------
  { method: "post", path: "/v1/organizations/{organizationId}/branches", contract: branch.createBranchRequest, bodyComponent: "BranchCreateRequest", summary: "Create a branch", tags: ["Branches"], auth: "staff", successStatus: 201 },
  { method: "get", path: "/v1/organizations/{organizationId}/branches", contract: branch.listBranchesRequest, summary: "List branches", tags: ["Branches"], auth: "staff", successStatus: 200 },
  { method: "get", path: "/v1/organizations/{organizationId}/branches/{branchId}", contract: branch.getBranchRequest, summary: "Read a branch", tags: ["Branches"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}/branches/{branchId}", contract: branch.updateBranchRequest, bodyComponent: "BranchUpdateRequest", summary: "Update a branch (PATCH semantics)", tags: ["Branches"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}/branches/{branchId}/status", contract: branch.changeBranchStatusRequest, bodyComponent: "StatusChangeRequest", summary: "Activate or deactivate a branch", tags: ["Branches"], auth: "staff", successStatus: 200 },

  // --- Clients (customer_account: who commissions an event; not attendees) -----------------------
  { method: "post", path: "/v1/organizations/{organizationId}/customer-accounts", contract: customerAccount.createCustomerAccountRequest, bodyComponent: "CustomerAccountCreateRequest", summary: "Record a client commissioning events (an organization or an individual)", tags: ["Clients"], auth: "staff", successStatus: 201 },
  { method: "get", path: "/v1/organizations/{organizationId}/customer-accounts", contract: customerAccount.listCustomerAccountsRequest, summary: "List clients", tags: ["Clients"], auth: "staff", successStatus: 200 },
  { method: "get", path: "/v1/organizations/{organizationId}/customer-accounts/{customerAccountId}", contract: customerAccount.getCustomerAccountRequest, summary: "Read a client", tags: ["Clients"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}/customer-accounts/{customerAccountId}", contract: customerAccount.updateCustomerAccountRequest, bodyComponent: "CustomerAccountUpdateRequest", summary: "Update a client (PATCH semantics)", tags: ["Clients"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}/customer-accounts/{customerAccountId}/status", contract: customerAccount.changeCustomerAccountStatusRequest, bodyComponent: "StatusChangeRequest", summary: "Activate or deactivate a client", tags: ["Clients"], auth: "staff", successStatus: 200 },

  // --- Venues -----------------------------------------------------------------------------------
  { method: "post", path: "/v1/organizations/{organizationId}/venues", contract: venue.createVenueRequest, bodyComponent: "VenueCreateRequest", summary: "Create a reusable physical venue", tags: ["Venues"], auth: "staff", successStatus: 201 },
  { method: "get", path: "/v1/organizations/{organizationId}/venues", contract: venue.listVenuesRequest, summary: "List venues", tags: ["Venues"], auth: "staff", successStatus: 200 },
  { method: "get", path: "/v1/organizations/{organizationId}/venues/{venueId}", contract: venue.getVenueRequest, summary: "Read a venue", tags: ["Venues"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}/venues/{venueId}", contract: venue.updateVenueRequest, bodyComponent: "VenueUpdateRequest", summary: "Update a venue (PATCH semantics)", tags: ["Venues"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}/venues/{venueId}/status", contract: venue.changeVenueStatusRequest, bodyComponent: "StatusChangeRequest", summary: "Activate or deactivate a venue", tags: ["Venues"], auth: "staff", successStatus: 200 },

  // --- Events -----------------------------------------------------------------------------------
  { method: "post", path: "/v1/organizations/{organizationId}/events", contract: event.createEventRequest, bodyComponent: "EventCreateRequest", summary: "Create an event (DRAFT, UNLISTED unless PUBLIC is chosen; General Admission is added; timezone defaults to the organization's)", tags: ["Events"], auth: "staff", successStatus: 201 },
  { method: "get", path: "/v1/organizations/{organizationId}/events", contract: event.listEventsRequest, summary: "List events (display_status shows LIVE during a published event)", tags: ["Events"], auth: "staff", successStatus: 200 },
  { method: "get", path: "/v1/organizations/{organizationId}/events/{eventId}", contract: event.getEventRequest, summary: "Read an event", tags: ["Events"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}/events/{eventId}", contract: event.updateEventRequest, bodyComponent: "EventUpdateRequest", summary: "Update an event (PATCH semantics; the slug is frozen after the first publication; set registration_closes_at to stop sign-ups early)", tags: ["Events"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}/events/{eventId}/status", contract: event.changeEventStatusRequest, bodyComponent: "EventStatusChangeRequest", summary: "Publish, close or cancel an event (DRAFT→PUBLISHED|CANCELLED, PUBLISHED→CLOSED|CANCELLED)", tags: ["Events"], auth: "staff", successStatus: 200 },
  { method: "put", path: "/v1/organizations/{organizationId}/events/{eventId}/cover", contract: event.setEventCoverRequest, fileUpload: { field: "file", description: "JPEG, PNG or WebP, up to 5 MB, checked by its contents. One file and no other fields." }, summary: "Upload and attach the event's cover image (replaces the current cover; cover.url in the reply is a path under /assets/uploads)", description: "Errors: 400 missing file, extra file or extra field; 413 over 5 MB; 415 not a JPEG, PNG or WebP; 409 CLOSED or CANCELLED event; 503 storage unavailable.", tags: ["Events"], auth: "staff", successStatus: 200 },
  { method: "delete", path: "/v1/organizations/{organizationId}/events/{eventId}/cover", contract: event.removeEventCoverRequest, summary: "Remove the event's cover image (the event then has cover: null)", tags: ["Events"], auth: "staff", successStatus: 200 },

  // --- Ticket types -----------------------------------------------------------------------------
  { method: "post", path: "/v1/organizations/{organizationId}/events/{eventId}/ticket-types", contract: ticketType.createTicketTypeRequest, bodyComponent: "TicketTypeCreateRequest", summary: "Add a free ticket type (its limit must fit within the event's capacity)", tags: ["Ticket types"], auth: "staff", successStatus: 201 },
  { method: "get", path: "/v1/organizations/{organizationId}/events/{eventId}/ticket-types", contract: ticketType.listTicketTypesRequest, summary: "List an event's ticket types", tags: ["Ticket types"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}/events/{eventId}/ticket-types/{ticketTypeId}", contract: ticketType.updateTicketTypeRequest, bodyComponent: "TicketTypeUpdateRequest", summary: "Update a ticket type (PATCH semantics)", tags: ["Ticket types"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}/events/{eventId}/ticket-types/{ticketTypeId}/status", contract: ticketType.changeTicketTypeStatusRequest, bodyComponent: "StatusChangeRequest", summary: "Activate or deactivate a ticket type (a published event keeps at least one active)", tags: ["Ticket types"], auth: "staff", successStatus: 200 },

  // --- Roles and staff assignments (Phase 2b) ---------------------------------------------------------
  { method: "get", path: "/v1/organizations/{organizationId}/roles", contract: role.listRolesRequest, summary: "The organization's roles and what each may do, module by module, with grant_count, member_count and role_template. Filter: role_template_id", tags: ["Access control"], auth: "staff", successStatus: 200 },
  { method: "post", path: "/v1/organizations/{organizationId}/roles", contract: role.createRoleRequest, bodyComponent: "RoleCreateRequest", summary: "Create a role with its grants: all 7 actions per module (view, create, update required; delete, import, export, notify optional, left out means no). Optional role_template_id (an active template): without grants its grants are copied; the role remembers the template. The code is fixed afterwards", description: "Errors: 400 validation_error (a module or action a tenant role may not hold, named in issues[].path; or neither grants nor role_template_id); 403 grant_exceeds_own_access (details.module_code and action: you can't grant what you don't hold); 404 unknown template; 409 role_template_inactive; 409 conflict (field code or name).", tags: ["Access control"], auth: "staff", successStatus: 201 },
  { method: "get", path: "/v1/organizations/{organizationId}/roles/{roleId}", contract: role.getRoleRequest, summary: "Read a role and its grants", tags: ["Access control"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}/roles/{roleId}", contract: role.updateRoleRequest, bodyComponent: "RoleUpdateRequest", summary: "Edit a role's name, description or grants (grants replaces the whole set; a box left out keeps the role's current value). Applies on the next request", description: "Errors: as for creating, plus 409 role_locked for the built-in OWNER.", tags: ["Access control"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}/roles/{roleId}/status", contract: role.changeRoleStatusRequest, bodyComponent: "StatusChangeRequest", summary: "Switch a role off or back on", description: "Errors: 409 role_locked (OWNER); 409 role_in_use (details.active_assignments: reassign those staff first).", tags: ["Access control"], auth: "staff", successStatus: 200 },
  { method: "get", path: "/v1/organizations/{organizationId}/staff-lookup", contract: staffAssignment.lookUpStaffRequest, summary: "Find the Cheche account using a mobile number, to confirm the person before assigning a role (404 central_account_not_found when there is none)", tags: ["Access control"], auth: "staff", successStatus: 200 },
  { method: "get", path: "/v1/organizations/{organizationId}/staff-assignments", contract: staffAssignment.listStaffAssignmentsRequest, summary: "The organization's staff: role, branch and name (profile is null when Central Auth can't be read). Filters: is_active, role_id (the members of a role), branch_id", tags: ["Access control"], auth: "staff", successStatus: 200 },
  { method: "post", path: "/v1/organizations/{organizationId}/staff-assignments", contract: staffAssignment.createStaffAssignmentRequest, bodyComponent: "StaffAssignmentCreateRequest", summary: "Give the person behind a mobile number a role of this organization: 201 when given (new or reactivated), 200 when they already had it. With new_account, a Cheche account is created when the mobile has none (account_created in the reply)", description: "The mobile is looked up in Central Auth on the server. Without an account and without new_account: 404 central_account_not_found. new_account { firstname, middlename?, lastname, password (8 to 128) } creates a verified Cheche account; the password is never stored, logged or returned, and is ignored when the account exists. Errors: 404 central_account_not_found, 409 conflict (already staff of another organization or the platform), 409 role_inactive, 409 branch_inactive, 409 invalid_branch_state (no branches), 409 assignment_scope_conflict (the same role organization-wide and on a branch), 503 central_auth_unavailable.", tags: ["Access control"], auth: "staff", successStatus: 201 },
  { method: "get", path: "/v1/organizations/{organizationId}/staff-assignments/{assignmentId}", contract: staffAssignment.getStaffAssignmentRequest, summary: "Read one staff assignment: role, branch and the person's name from Central Auth (profile null when it can't be read)", tags: ["Access control"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}/staff-assignments/{assignmentId}", contract: staffAssignment.updateStaffAssignmentRequest, bodyComponent: "StaffAssignmentUpdateRequest", summary: "Change the role or branch of an assignment (the last active Owner keeps the Owner role: 409 last_owner_assignment). When the role changes, data.override_count says how many permission overrides the person still has", tags: ["Access control"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}/staff-assignments/{assignmentId}/status", contract: staffAssignment.changeStaffAssignmentStatusRequest, bodyComponent: "StatusChangeRequest", summary: "Activate or deactivate an assignment (the last active Owner can't be deactivated: 409 last_owner_assignment)", tags: ["Access control"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}/staff-assignments/{assignmentId}/profile", contract: staffAssignment.updateStaffProfileRequest, bodyComponent: "StaffProfileUpdateRequest", summary: "Change a staff member's names in their Cheche account (names only: never mobile, email, password or status)", description: "Errors: 409 central_auth_refused (Cheche accounts refused the change); 404 unknown assignment; 503 central_auth_unavailable.", tags: ["Access control"], auth: "staff", successStatus: 200 },
  { method: "delete", path: "/v1/organizations/{organizationId}/staff-assignments/{assignmentId}", contract: staffAssignment.deleteStaffAssignmentRequest, summary: "Delete an assignment for good (needs Staff Assignments › delete); its permission overrides go with it. 204", description: "Errors: 409 last_owner_assignment (the last active Owner); 409 own_assignment (your own).", tags: ["Access control"], auth: "staff", successStatus: 204 },
  { method: "get", path: "/v1/organizations/{organizationId}/grantable-modules", contract: role.listGrantableModulesRequest, summary: "The modules and actions an organization's roles, templates and overrides may grant (Roles › view or Staff Assignments › view)", tags: ["Access control"], auth: "staff", successStatus: 200 },
  { method: "get", path: "/v1/organizations/{organizationId}/staff-assignments/{assignmentId}/overrides", contract: staffAssignment.listStaffOverridesRequest, summary: "One staff member's permission overrides: per module, what the role gives, the override (true, false or null = follow the role) and the effective result", tags: ["Access control"], auth: "staff", successStatus: 200 },
  { method: "put", path: "/v1/organizations/{organizationId}/staff-assignments/{assignmentId}/overrides", contract: staffAssignment.replaceStaffOverridesRequest, bodyComponent: "StaffOverridesReplaceRequest", summary: "Replace one staff member's permission overrides (a module with every box null is removed). Applies on the next request", description: "Errors: 400 validation_error (a module or action a tenant may not hold, named in issues[].path); 403 grant_exceeds_own_access (allowing an action you don't hold); 409 owner_not_overridable (an Owner's assignment); 409 own_assignment (your own).", tags: ["Access control"], auth: "staff", successStatus: 200 },
  { method: "get", path: "/v1/organizations/{organizationId}/role-templates", contract: roleTemplate.listOrganizationRoleTemplatesRequest, summary: "The active role templates an Owner may start a role from (needs Roles › create); the role is then made with POST /roles", tags: ["Access control"], auth: "staff", successStatus: 200 },
  { method: "get", path: "/v1/role-templates", contract: roleTemplate.listRoleTemplatesRequest, summary: "Every role template (platform scope, Super Admin)", tags: ["Access control"], auth: "staff", successStatus: 200 },
  { method: "post", path: "/v1/role-templates", contract: roleTemplate.createRoleTemplateRequest, bodyComponent: "RoleTemplateCreateRequest", summary: "Create a role template (platform scope). Grants follow the same rules as an organization's roles; the code is fixed afterwards", description: "Errors: 400 validation_error (a module or action a tenant may not hold); 409 conflict (field code or name).", tags: ["Access control"], auth: "staff", successStatus: 201 },
  { method: "get", path: "/v1/role-templates/{templateId}", contract: roleTemplate.getRoleTemplateRequest, summary: "Read a role template (platform scope)", tags: ["Access control"], auth: "staff", successStatus: 200 },
  { method: "get", path: "/v1/role-templates/{templateId}/roles", contract: roleTemplate.listTemplateRolesRequest, summary: "The roles made from this template, in every organization (platform scope). Copies: they don't change when the template does", tags: ["Access control"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/role-templates/{templateId}", contract: roleTemplate.updateRoleTemplateRequest, bodyComponent: "RoleTemplateUpdateRequest", summary: "Edit a role template's name, description, grants or 'for new organizations' (platform scope). Existing roles never change", description: "Errors: as for creating, plus 409 role_locked for the OWNER template.", tags: ["Access control"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/role-templates/{templateId}/status", contract: roleTemplate.changeRoleTemplateStatusRequest, bodyComponent: "StatusChangeRequest", summary: "Switch a role template off or on (platform scope; the OWNER template: 409 role_locked)", tags: ["Access control"], auth: "staff", successStatus: 200 },
  { method: "get", path: "/v1/platform/roles", contract: platform.listPlatformRolesRequest, summary: "Platform roles (no organization), with grants and member counts (platform scope)", tags: ["Platform"], auth: "staff", successStatus: 200 },
  { method: "post", path: "/v1/platform/roles", contract: platform.createPlatformRoleRequest, bodyComponent: "PlatformRoleCreateRequest", summary: "Create a platform role: any active permission module, all 7 actions. Its grants on tenant modules apply in every organization", description: "Errors: 400 validation_error (an unknown module); 403 grant_exceeds_own_access; 409 conflict (field code or name).", tags: ["Platform"], auth: "staff", successStatus: 201 },
  { method: "get", path: "/v1/platform/roles/{roleId}", contract: platform.getPlatformRoleRequest, summary: "Read a platform role", tags: ["Platform"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/platform/roles/{roleId}", contract: platform.updatePlatformRoleRequest, bodyComponent: "PlatformRoleUpdateRequest", summary: "Edit a platform role's name, description or grants (grants replaces the whole set)", description: "Errors: as for creating, plus 409 role_locked for SUPER_ADMIN.", tags: ["Platform"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/platform/roles/{roleId}/status", contract: platform.changePlatformRoleStatusRequest, bodyComponent: "StatusChangeRequest", summary: "Switch a platform role off or on", description: "Errors: 409 role_locked (SUPER_ADMIN); 409 role_in_use (details.active_assignments).", tags: ["Platform"], auth: "staff", successStatus: 200 },
  { method: "get", path: "/v1/platform/staff-assignments", contract: platform.listPlatformStaffRequest, summary: "Platform staff, with names from Central Auth (filters: is_active, role_id)", tags: ["Platform"], auth: "staff", successStatus: 200 },
  { method: "post", path: "/v1/platform/staff-assignments", contract: platform.createPlatformStaffRequest, bodyComponent: "PlatformStaffCreateRequest", summary: "Give the person behind a mobile a platform role (new_account creates their Cheche account): 201 given, 200 already had it", description: "Errors: 404 central_account_not_found; 409 conflict (field user_id: staff of an organization); 409 role_inactive; 503 central_auth_unavailable.", tags: ["Platform"], auth: "staff", successStatus: 201 },
  { method: "get", path: "/v1/platform/staff-assignments/{assignmentId}", contract: platform.getPlatformStaffRequest, summary: "Read one platform staff assignment", tags: ["Platform"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/platform/staff-assignments/{assignmentId}", contract: platform.updatePlatformStaffRequest, bodyComponent: "PlatformStaffUpdateRequest", summary: "Give a platform staff member another platform role", description: "Errors: 409 last_super_admin; 409 own_assignment; 409 role_inactive.", tags: ["Platform"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/platform/staff-assignments/{assignmentId}/status", contract: platform.changePlatformStaffStatusRequest, bodyComponent: "StatusChangeRequest", summary: "Switch a platform staff assignment off or on", description: "Errors: 409 last_super_admin; 409 own_assignment; 409 role_inactive.", tags: ["Platform"], auth: "staff", successStatus: 200 },
  { method: "delete", path: "/v1/platform/staff-assignments/{assignmentId}", contract: platform.deletePlatformStaffRequest, summary: "Delete a platform staff assignment for good. 204", description: "Errors: 409 last_super_admin; 409 own_assignment.", tags: ["Platform"], auth: "staff", successStatus: 204 },
  { method: "get", path: "/v1/modules", contract: moduleValidators.listModulesRequest, summary: "Every module as a tree in menu order (platform scope, Super Admin)", tags: ["Access control"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/modules/{moduleId}", contract: moduleValidators.updateModuleRequest, bodyComponent: "ModuleUpdateRequest", summary: "Change a module's name, description, order or icon (platform scope). Codes, routes, parents and on/off can't change", tags: ["Access control"], auth: "staff", successStatus: 200 },

  // --- Guests (person: reusable attendee profiles) -------------------------------------------------
  { method: "post", path: "/v1/organizations/{organizationId}/persons", contract: person.createPersonRequest, bodyComponent: "PersonCreateRequest", summary: "Create a guest profile (only first_name is required; Ethiopian mobiles are stored as +251…)", tags: ["Guests"], auth: "staff", successStatus: 201 },
  { method: "get", path: "/v1/organizations/{organizationId}/persons", contract: person.listPersonsRequest, summary: "Search guest profiles (q matches names, email and phone)", tags: ["Guests"], auth: "staff", successStatus: 200 },
  { method: "get", path: "/v1/organizations/{organizationId}/persons/{personId}", contract: person.getPersonRequest, summary: "Read a guest profile with their registrations in this organization (to confirm a returning guest)", tags: ["Guests"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}/persons/{personId}", contract: person.updatePersonRequest, bodyComponent: "PersonUpdateRequest", summary: "Update a guest profile (PATCH semantics)", tags: ["Guests"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}/persons/{personId}/status", contract: person.changePersonStatusRequest, bodyComponent: "StatusChangeRequest", summary: "Activate or deactivate a guest profile (a deactivated guest can't be registered)", tags: ["Guests"], auth: "staff", successStatus: 200 },

  // --- Registrations (an event's guest list) --------------------------------------------------------
  { method: "post", path: "/v1/organizations/{organizationId}/events/{eventId}/registrations", contract: registration.createRegistrationRequest, bodyComponent: "RegistrationCreateRequest", summary: "Register a guest (person_id or a new person); 201 when a place was taken, 200 when already registered", description: "Same rules as the public form: a PUBLISHED event, not ended, inside its registration window, an active ticket type and a free place at both the event and the ticket type. Errors: 409 registration_closed (details.reason), 409 capacity_reached (details.scope), 409 already_registered, 409 ticket_type_inactive, 409 person_inactive, 400 ticket_type_required.", tags: ["Registrations"], auth: "staff", successStatus: 201 },
  { method: "get", path: "/v1/organizations/{organizationId}/events/{eventId}/registrations", contract: registration.listRegistrationsRequest, summary: "The event's guest list, newest first (q searches the guest's names, email and phone)", tags: ["Registrations"], auth: "staff", successStatus: 200 },
  { method: "get", path: "/v1/organizations/{organizationId}/events/{eventId}/registrations/summary", contract: registration.getRegistrationSummaryRequest, summary: "Places confirmed and left, for the event and each ticket type", tags: ["Registrations"], auth: "staff", successStatus: 200 },
  { method: "get", path: "/v1/organizations/{organizationId}/events/{eventId}/registrations/export", contract: registration.exportRegistrationsRequest, successContent: "text/csv", summary: "Download the guest list as CSV (needs REGISTRATIONS export): the list's filters and order, every matching guest in one file named {event-slug}-guests.csv", description: "UTF-8 with a byte-order mark. Dates in the event's time zone, Ethiopian first, then Gregorian with a 12-hour time. Cells that start like a formula get a leading apostrophe; Ethiopian mobiles are written as 0911 234 567. Errors (JSON): 400 validation_error (paging isn't accepted), 403 permission_denied, 404 unknown event.", tags: ["Registrations"], auth: "staff", successStatus: 200 },
  { method: "get", path: "/v1/organizations/{organizationId}/events/{eventId}/registrations/{registrationId}", contract: registration.getRegistrationRequest, summary: "Read a registration", tags: ["Registrations"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}/events/{eventId}/registrations/{registrationId}/status", contract: registration.changeRegistrationStatusRequest, bodyComponent: "RegistrationStatusChangeRequest", summary: "Cancel a registration (frees the place) or reactivate it (every registration check again)", tags: ["Registrations"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}/events/{eventId}/registrations/{registrationId}/ticket-type", contract: registration.changeRegistrationTicketTypeRequest, bodyComponent: "RegistrationTicketTypeChangeRequest", summary: "Move a confirmed guest to another ticket type of the event: same code, no SMS; the same ticket type again changes nothing", description: "PUBLISHED events only, at any time (also after sign-ups close). The new ticket type must be active and have room under its own limit; the event's total doesn't change. Errors: 404 unknown ticket type, 409 invalid_event_state (details.status), 409 registration_cancelled (bring the guest back first), 409 ticket_type_inactive, 409 capacity_reached (details.scope TICKET_TYPE).", tags: ["Registrations"], auth: "staff", successStatus: 200 },

  // --- Public (no login) ------------------------------------------------------------------------
  { method: "get", path: "/v1/public/events", contract: publicEvent.listPublicEventsRequest, summary: "Public catalog: upcoming and live PUBLISHED + PUBLIC events of active organizations, by start time (filters: exact category, organization slug)", tags: ["Public"], auth: "public", successStatus: 200 },
  { method: "get", path: "/v1/public/organizations/{organizationSlug}/events/{eventSlug}", contract: publicEvent.getPublicEventRequest, summary: "Public event page by both slugs: any event published at least once (also UNLISTED, ended, closed or cancelled); 404 for drafts", tags: ["Public"], auth: "public", successStatus: 200 },
  { method: "post", path: "/v1/public/organizations/{organizationSlug}/events/{eventSlug}/registrations", contract: publicRegistration.createPublicRegistrationRequest, bodyComponent: "PublicRegistrationRequest", summary: "Register for an event, without an account or signed in with one (Idempotency-Key required): 201 with the code; the same key and form again, or a signed-in guest already registered, returns the registration with 200", description: "Without an account, phone is required and a new, unlinked guest profile is made. With a guest's access token, phone is ignored: the account's linked profile is used or created with its verified mobile. Same rules as staff entry: the event must be taking registrations, the ticket type active and a place free. Errors: 400 validation_error (e.g. headers.idempotency-key, a non-Ethiopian mobile), 404 unknown event, 409 privacy_notice_outdated (details.current), 409 idempotency_key_reused, 409 registration_closed (details.reason), 409 capacity_reached (details.scope), 400 ticket_type_required, 429 rate_limited (10 a minute per IP).", tags: ["Public"], auth: "customer-optional", successStatus: 201 },
];

// ---------------------------------------------------------------------------------------------
// Document builder: Zod is the single source of truth; no prototype patching, no global registry.
// ---------------------------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;
type Parameter = { name: string; in: "path" | "query" | "header"; required: boolean; schema: JsonSchema };
type Operation = {
  summary: string;
  description?: string;
  tags: string[];
  security: Array<Record<string, string[]>>;
  parameters?: Parameter[];
  requestBody?: { required: boolean; content: Record<string, { schema: JsonSchema }> };
  responses: Record<string, unknown>;
};
export type OpenApiDocument = {
  openapi: "3.0.3";
  info: { title: string; version: string };
  servers: Array<{ url: string }>;
  paths: Record<string, Partial<Record<HttpMethod, Operation>>>;
  components: { schemas: Record<string, JsonSchema>; securitySchemes: Record<string, unknown> };
};

/** Documents the transport (input) shape; refinements/transforms are runtime-only and described in prose. */
function toJsonSchema(schema: z.ZodType): JsonSchema {
  const converted = z.toJSONSchema(schema, { target: "openapi-3.0", io: "input", unrepresentable: "any" }) as JsonSchema;
  delete converted.$schema;
  return converted;
}

/** "idempotency-key" → "Idempotency-Key": header names are case-insensitive; this is how clients write them. */
const headerDisplayName = (name: string) => name.replace(/(^|-)([a-z])/g, (_match, dash: string, letter: string) => `${dash}${letter.toUpperCase()}`);

function parametersOf(location: "path" | "query" | "header", schema: z.ZodObject | undefined): Parameter[] {
  if (!schema) return [];
  const fields = Object.entries(schema.shape) as Array<[string, z.ZodType]>;
  return fields.map(([name, field]) => ({
    name: location === "header" ? headerDisplayName(name) : name,
    in: location,
    required: location === "path" || !field.safeParse(undefined).success,
    schema: toJsonSchema(field),
  }));
}

function securityFor(auth: ApiOperation["auth"]): Array<Record<string, string[]>> {
  if (auth === "staff") return [{ bearerAuth: [] }];
  if (auth === "refresh-cookie") return [{ refreshCookie: [] }];
  if (auth === "customer-refresh-cookie") return [{ customerRefreshCookie: [] }];
  if (auth === "customer") return [{ customerBearer: [] }];
  if (auth === "customer-optional") return [{}, { customerBearer: [] }];
  return [];
}

const ErrorEnvelopeSchema = z.object({
  success: z.literal(false),
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});

export function buildV1Document(): OpenApiDocument {
  const schemas: Record<string, JsonSchema> = { ErrorEnvelope: toJsonSchema(ErrorEnvelopeSchema) };
  const componentOwners = new Map<string, z.ZodType>();
  const paths: OpenApiDocument["paths"] = {};

  for (const operation of v1Operations) {
    const { contract } = operation;
    const label = `${operation.method.toUpperCase()} ${operation.path}`;

    const placeholders = [...operation.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort();
    const pathParams = Object.keys(contract.params?.shape ?? {}).sort();
    if (placeholders.join() !== pathParams.join()) {
      throw new Error(`${label}: path placeholders [${placeholders.join()}] must equal contract params [${pathParams.join()}]`);
    }
    if (Boolean(contract.body) !== Boolean(operation.bodyComponent)) {
      throw new Error(`${label}: bodyComponent must be set exactly when the contract has a body`);
    }

    if (operation.fileUpload && contract.body) throw new Error(`${label}: a file upload cannot also have a JSON body`);

    let requestBody: Operation["requestBody"];
    if (operation.fileUpload) {
      const { field, description } = operation.fileUpload;
      requestBody = {
        required: true,
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              required: [field],
              properties: { [field]: { type: "string", format: "binary", description } },
              additionalProperties: false,
            },
          },
        },
      };
    }
    if (contract.body && operation.bodyComponent) {
      const owner = componentOwners.get(operation.bodyComponent);
      if (owner && owner !== contract.body) throw new Error(`Component ${operation.bodyComponent} names two different schemas`);
      if (!owner) {
        componentOwners.set(operation.bodyComponent, contract.body);
        schemas[operation.bodyComponent] = toJsonSchema(contract.body);
      }
      requestBody = {
        required: !contract.body.safeParse(undefined).success,
        content: { "application/json": { schema: { $ref: `#/components/schemas/${operation.bodyComponent}` } } },
      };
    }

    const parameters = [
      ...parametersOf("path", contract.params),
      ...parametersOf("query", contract.query),
      ...parametersOf("header", contract.headers),
    ];
    (paths[operation.path] ??= {})[operation.method] = {
      summary: operation.summary,
      ...(operation.description ? { description: operation.description } : {}),
      tags: operation.tags,
      security: securityFor(operation.auth),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(requestBody ? { requestBody } : {}),
      responses: {
        [String(operation.successStatus)]: operation.successContent
          ? { description: "The file", content: { [operation.successContent]: { schema: { type: "string" } } } }
          : { description: "Success envelope: { success: true, data, meta?, message? }" },
        default: {
          description: "Error envelope",
          content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
        },
      },
    };
  }

  return {
    openapi: "3.0.3",
    info: { title: APP_TITLE, version: "1.0.0" },
    servers: [{ url: "/" }],
    paths,
    components: {
      schemas,
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        refreshCookie: { type: "apiKey", in: "cookie", name: STAFF_REFRESH_COOKIE },
        customerRefreshCookie: { type: "apiKey", in: "cookie", name: CUSTOMER_REFRESH_COOKIE },
        customerBearer: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "A guest's Cheche access token (from /v1/auth/customer/*)" },
      },
    },
  };
}
