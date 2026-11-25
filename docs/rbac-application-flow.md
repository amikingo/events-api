# Multi-Tenant RBAC

## Tables

`module` (permission subjects + navigation nodes) · `role` (`organization_id NULL` = platform role) ·
`role_module_access` (grant matrix) · `user_role` (assignment: Central Auth user + role + organization/branch
scope) · `user_module_access` (per-assignment overrides; `NULL` = inherit).

Permission actions: `view`, `create`, `update`, `delete`, `import`, `export`, `notify`.

## Scopes

Every `requirePermission` declares a scope:

- `"platform"` — platform-wide resources (create/list tenants, module catalogue, role templates, cross-tenant
  feeds). Only platform assignments can satisfy it.
- `organizationScopeFromParams` — tenant resources under `/v1/organizations/:organizationId[/…/:branchId]`.

## Only the signed-in assignment counts

A person may hold several assignments (e.g. "Gate staff" and "Org manager"). Every request is authorized for
**the one assignment they are signed in as**: `requirePermission` passes the staff token's `assignment_id` to
`resolvePermission`, and only that assignment's role grants and override are considered. To use another role, the
user switches (`POST /v1/auth/staff/switch-assignment`), which re-issues the token. `GET /v1/auth/staff/me` shows
the same single assignment, so screens and API always agree.

`resolvePermission` requires `assignmentId` explicitly. `null` combines all of a user's assignments and exists for
internal callers only; never pass `null` while handling a request. Any service that authorizes a second action in
the same request must pass `req.auth.assignmentId` too.

## Resolution order

1. Module must exist, be active and permission-bearing — else deny (`module_unavailable`).
2. A scope branch must belong to the scope organization — else `InvalidScopeError`.
3. Applicable assignments: only the signed-in assignment (or all of the user's, when `assignmentId` is `null`),
   kept when the assignment, role, organization and branch are active and it fits the scope: platform assignments
   apply everywhere; tenant assignments only inside their organization; organization-wide covers all branches;
   branch-scoped only its branch. None — deny (`no_assignment`).
4. Platform `SUPER_ADMIN` — allow (`super_admin_bypass`). Only when the signed-in assignment is the super admin one.
5. (Extension point) organization feature gates.
6. Explicit overrides, branch-specific bucket first, then organization-wide/platform; deny wins among equals.
7. Any role grant — allow (`role_permission`), else deny (`default_deny`).

## Assignment integrity

Service rules with friendly errors, backed by `fn_user_role_scope_guard` and constraints: platform assignments
use platform roles; tenant assignments use roles of the same organization; a branch must belong to the assignment's
organization (composite FK); a user is platform staff or staff of exactly one organization.

## Session and navigation

`GET /v1/auth/staff/me` returns a flat `permissions` map keyed by module code and a nested `navigation` tree:
only `is_menu` modules; permission modules need effective `view`; non-permission modules with a `route_name` are
destinations; containers without a route appear only with visible descendants; ordered by `sno`. Frontend checks
are UX only — backend middleware is the authority.

## Adding a permission module

1. Add the code to `src/utils/module-codes.ts` (UPPER_SNAKE_CASE).
2. Add a migration inserting the `module` row (deterministic UUID, parent container, `sno`, `route_name`, `icon`).
3. Gate routes with `requirePermission({ moduleCode, action, scope })`.
4. The integration test fails if a code in `MODULE_CODES` has no row.

## Default roles and provisioning (scripts)

Every new organization (the app's `POST /v1/organizations` and `provision:organizer` alike) starts with roles copied
from the active **role templates** marked for new organizations (Phase 2d; see below). At first those are OWNER and
VIEWER, seeded from `src/utils/default-roles.ts`, which is also the fallback when no OWNER template exists:

| Role | Grants |
|---|---|
| `OWNER` | `ORGANIZATIONS` view, update · `BRANCHES`, `ROLES`, `USER_ROLES`, `EVENTS`, `CUSTOMERS` view, create, update · `REGISTRATIONS` view, create, update, export |
| `VIEWER` | `ORGANIZATIONS`, `BRANCHES`, `EVENTS`, `CUSTOMERS`, `REGISTRATIONS` view |

Existing organizations are extended through grant migrations (`20261125000003`, `20261126000004`, `20261127000000`,
`20261128000000`, `20261129000000`); a future grant migration updates the OWNER template too. A default role never gets
a platform-only module (`MODULES`, `ROLE_TEMPLATES`).

Operational scripts. Each previews by default, writes only with `--confirm`, prints JSON, and loads `.env`, so the
project owner runs it:

```bash
npm run provision:organizer -- --name "Selam Events" --owner-user-id <uuid> [--slug selam-events] [--has-branches] [--confirm]
npm run assign:staff -- --organization-slug selam-events --user-id <uuid> --role-code VIEWER [--branch-code ADDIS] [--confirm]
npm run dev:staff-token -- --user-id <uuid> [--assignment-id <uuid>]     # development only
```

- `provision:organizer` creates the organization, its `MAIN` branch, the two roles with their grants and the
  owner's organization-wide assignment, all in one transaction (`organizationProvisioningService`). Without
  `--has-branches` the organization has no branches (see below).
- `assign:staff` gives a person a role, organization-wide or for one branch. An identical active assignment is
  left unchanged; an identical **inactive** one is reactivated rather than duplicated.
- `dev:staff-token` prints a normal 15-minute staff token for one of the person's assignments, so staff screens
  work without auth-cheche. It refuses to run unless `NODE_ENV=development`. With the shared `APP_AUTH_TOKEN`
  (see `docs/authentication.md`, "Known risk"), anyone holding the secret could sign such a token anyway; the
  script adds convenience, not a new capability.

Rules both write paths enforce, with friendly errors before the database's backstop:

- **One person, one organization, counting inactive assignments.** `fn_user_role_scope_guard` refuses an
  assignment when the person has *any* other assignment (active or not) in another organization or at platform
  level, and the service mirrors that. Someone who once worked for organization A cannot be added to B until their
  old rows are removed. Writes for one person are serialized with an advisory lock, because the trigger alone
  cannot see another transaction's uncommitted row.
- **Tenant staff and the *Organizations* menu item.** `ORGANIZATIONS.view` (needed to read your own
  organization) makes the seeded *Administration › Organizations* item (`/organizations`) visible to tenant staff,
  but listing organizations is platform-only. The frontend should open the person's **own** organization
  (`/organizations/{assignment.organization_id}`) for tenant staff.

## Organizations without branches

Most organizers have no branches. `organization.has_branches` (default `false`) records the choice:

- Every organization still gets a default `MAIN` branch, created with it, so anything that needs a branch can
  rely on one. With `has_branches = false` that branch is **hidden**:
  - `/me` reports `assignment.organization.has_branches = false`;
  - the server leaves the *Branches* item out of the navigation. The `permissions` map is unchanged, because it
    states what the API allows. Platform staff always see *Branches*.
- **Adding a branch turns branches on.** `branch.service.createBranch` sets `has_branches = true` in the same
  transaction. From then on `MAIN` and the new branch are both visible, and the owner can rename `MAIN`.
- **No branch-limited staff while branches are off.** `assign:staff --branch-code` is refused with
  `invalid_branch_state`; add a branch first.
- Set it at creation with `POST /v1/organizations` `{ organization: { has_branches: true } }` or
  `provision:organizer --has-branches`.

## Managing staff over HTTP (Phase 2b, 25 November 2026)

Organizations manage their own staff in the app. These endpoints all sit under `/v1/organizations/{organizationId}`, and the scripts above still work:

| Call | Permission | Notes |
|---|---|---|
| `GET /roles`, `GET /roles/{roleId}` | `ROLES.view` | The organization's roles and what each may do. Creating and editing: see Phase 2c below. |
| `GET /staff-lookup?mobile=` | `USER_ROLES.create` | Who uses this mobile in auth-cheche (look up only; this API never creates accounts) |
| `GET /staff-assignments` | `USER_ROLES.view` | Role, branch and name. Names come from auth-cheche, best effort: `profile: null` when it can't be read. |
| `POST /staff-assignments` `{ mobile, role_id, branch_id? }` | `USER_ROLES.create` | The mobile is looked up again on the server; a `user_id` from the browser is never trusted |
| `PATCH /staff-assignments/{id}` `{ role_id?, branch_id? }` | `USER_ROLES.update` | |
| `PATCH /staff-assignments/{id}/status` `{ is_active }` | `USER_ROLES.update` | |

- **Who has these grants:** `OWNER` has view, create and update on Staff Assignments (migration `20261127000000`) and on Roles (view since Phase 2, create and update since migration `20261128000000`). `VIEWER` has neither, because the staff list shows phone numbers.
- **The rules,** in `src/services/staff-assignment.service.ts` and `staff-rules.ts`, shared with the scripts:
  - only roles of this organization (a platform role is not found);
  - a branch only when the organization has branches;
  - one person, one organization;
  - an identical active assignment is unchanged, and an identical inactive one is reactivated;
  - the **last active Owner** can't be deactivated or moved to another role (409 `last_owner_assignment`). Owner changes in one organization are serialized by an advisory lock, so two Owners can't remove each other at the same moment.
- **Modules, Role Templates and Permission Overrides** got endpoints in Phase 2d (below).
- **Every organization gets the default roles** (fixed 25 November 2026): `POST /v1/organizations` and `provision:organizer` both create `OWNER` and `VIEWER` with their grants, in the same transaction (`src/services/default-roles.service.ts`). Before the fix, organizations made in the app had no roles. Migration `20261127000100-backfill-default-roles` gives the defaults, once, to every organization that has no role at all.
- **The first Owner of an organization made in the app:** since Phase 2c, `POST /v1/organizations` takes an optional `owner_mobile` and adds that Owner in the same transaction. The Super Admin can still add one later through Staff Assignments. The script does it in one step (`--owner-user-id`).

### Rules for later role and access editing

When editing roles and role access over HTTP is built, these rules apply. Each is enforced in the service with a friendly error first; the
database trigger and constraints stay as the backstop.

- **Platform level is Super Admin only.** Only a platform Super Admin (signed in as that assignment) may
  create, change or remove an assignment with no organization, or use a role with no organization.
  *Why:* otherwise a tenant admin could hand someone platform access.
- **Tenant admins see their own organization by default.** Tenant endpoints live under
  `/v1/organizations/:organizationId/...` and are authorized for that organization, so a tenant admin's list
  of assignments is their own organization's. A cross-organization list is a separate platform-scoped endpoint.
- **A tenant can never grant platform modules to a role.** When a tenant role's access is edited, reject any
  module that is platform-only (e.g. `MODULES`, `ROLE_TEMPLATES`, and creating or listing organizations).
  *Why:* a tenant who can edit their own role could otherwise give it platform powers. Explicit platform scope
  already stops those grants from passing platform checks, but they must not be stored at all. bookings_api
  still has this gap, so it must be right here from the start.
  *Settled in Phase 2c:* a code constant, `TENANT_GRANTABLE` in `src/utils/rbac.ts`, lists what a tenant role
  may hold, per module and action; no database change. `ORGANIZATIONS` is listed with view and update only.

## Custom roles and organization switching (Phase 2c, 25 November 2026)

All under `/v1/organizations/{organizationId}`, in `src/services/role.service.ts`:

| Call | Permission |
|---|---|
| `POST /roles` `{ code, name, description?, grants: [{ module_code, view, create, update, export? }] }` | `ROLES.create` |
| `PATCH /roles/{roleId}` `{ name?, description?, grants? }` (`grants` replaces the whole set) | `ROLES.update` |
| `PATCH /roles/{roleId}/status` `{ is_active }` | `ROLES.update` |

- **What a tenant role may hold:** `TENANT_GRANTABLE`:

  | Module | Actions |
  |---|---|
  | `ORGANIZATIONS` | view, update (never create: creating tenants is platform work) |
  | `BRANCHES`, `ROLES`, `USER_ROLES`, `EVENTS`, `CUSTOMERS` | view, create, update |
  | `REGISTRATIONS` | view, create, update, export (Phase 4d: the guest list as CSV) |
  | `MODULES`, `ROLE_TEMPLATES`, `USER_MODULE_ACCESSES` | nothing |

  Anything else is `400 validation_error`, naming the module and action in `issues[].path`. Delete, import and notify are never stored as true: the API uses none of them. Export is stored only on `REGISTRATIONS`.
- **Export (Phase 4d):** `export` is optional in a grant. Left out on create, it means no. Left out on update, the role keeps the Export it has, so a client that doesn't know the box can't wipe it. New Owners get it from `default-roles.ts`; existing Owners from migration `20261129000000`. Viewers and custom roles get it only when someone with Export gives it to them.
- **No privilege escalation:** every action a request *adds* to a role is checked with `resolvePermission` for the editor's signed-in assignment, at organization scope. Actions the role already had need no check, so an editor can keep what's there. A refusal is `403 grant_exceeds_own_access` with `details.module_code` and `action`. An Owner holds every grantable action, and the Super Admin passes through the engine's bypass, so in practice this limits custom roles given *Roles › update*.
- **Built-in roles:** `OWNER` is locked (`409 role_locked`: no rename, re-grant or switch-off), so an organization can never lose its full-access role. `VIEWER` is editable like any created role. **Codes never change** after creation; names (unique per organization, ignoring case) and descriptions may.
- **Switching a role off** while active assignments hold it is `409 role_in_use` with `details.active_assignments`. Switching it on is always allowed. A role being edited or switched is row-locked, and so is the role an assignment is being given, so a role can't be switched off while someone is being given it.
- **When changes apply:** at once. The permission engine reads grants from the database on every request; the menu follows on the next `/me`.
- **Organizations:** `PATCH /v1/organizations/{id}` also edits `name` and `description` (`ORGANIZATIONS.update`); the slug never changes. `PATCH /v1/organizations/{id}/status` `{ is_active }` is **platform scope** (Super Admin only), so an Owner can't switch their own organization off. Switched off, the existing rules apply: staff get `organization_inactive` at sign-in, refresh and `/me`, every permission check denies, and its events leave the catalog (links answer 404). Switched on, everything returns; nothing is deleted.
- **The first Owner at creation:** `owner_mobile` on `POST /v1/organizations` is looked up in auth-cheche *before* the transaction (no lock waits on the network). Inside it: the person's assignments are locked, `staffRules.assertNotStaffElsewhere` runs, then the organization, its default roles and the Owner assignment are created together. No account (`404`) or already staff (`409`) creates nothing.
- **Not built:** deleting roles or organizations (they're switched off) and editing a slug.

## Permission overrides, role templates and modules (Phase 2d, 25 November 2026)

Shared code: `src/services/grant-rules.ts` holds the two rules every grant follows (roles, overrides, templates):
**grantable** (`TENANT_GRANTABLE`, 400 naming the module or action) and **held** (nobody hands out what they don't
hold in their signed-in assignment, 403 `grant_exceeds_own_access`).

**Permission overrides** give one staff member more or less than their role, module by module.

| Call | Permission |
|---|---|
| `GET /v1/organizations/{organizationId}/staff-assignments/{assignmentId}/overrides` | `USER_ROLES.view` |
| `PUT /v1/organizations/{organizationId}/staff-assignments/{assignmentId}/overrides` `{ overrides: [{ module_code, view?, create?, update?, export? }] }` | `USER_ROLES.update` |

- Each box is `true` (allow), `false` (deny) or `null` / left out (follow the role). Saving replaces the whole set; a
  module with every box null is removed (the table forbids an all-null row).
- The reply lists, per grantable module, `actions` (the boxes it offers), `role`, `override` and `effective`.
- Only `TENANT_GRANTABLE` modules and actions (400). Allowing needs the editor to hold the action (403); denying, or
  keeping an existing allow, needs nothing.
- Never on an Owner's assignment (409 `owner_not_overridable`): Owners always have full access, and an override can't
  lock an organization out. Never on your own assignment (409 `own_assignment`).
- They apply on the next request (the engine already reads them) and stay when the assignment's role changes. Then
  the PATCH reply carries `override_count` and says "Role changed. This person still has N permission overrides:
  review them."
- The *Permission Overrides* menu item (`USER_MODULE_ACCESSES`) stays hidden: overrides live on the staff page.

**Role templates** are a platform library (tables `role_template`, `role_template_module_access`).

| Call | Permission |
|---|---|
| `GET /v1/role-templates`, `GET /v1/role-templates/{templateId}` | `ROLE_TEMPLATES.view`, platform |
| `POST /v1/role-templates` `{ code, name, description?, for_new_organizations?, grants }` | `ROLE_TEMPLATES.create`, platform |
| `PATCH /v1/role-templates/{templateId}` `{ name?, description?, for_new_organizations?, grants? }`, `PATCH …/status` `{ is_active }` | `ROLE_TEMPLATES.update`, platform |
| `GET /v1/organizations/{organizationId}/role-templates` (active templates only) | `ROLES.create`, organization |

- Grants follow `TENANT_GRANTABLE`, like roles. Codes are fixed and unique; names unique (ignoring case).
- **OWNER is locked** (409 `role_locked`): no edits, never switched off, always for new organizations.
- New organizations get roles copied from the active templates marked `for_new_organizations`; without an OWNER template
  they fall back to `DEFAULT_TENANT_ROLES`. **Copies, never links:** editing a template never changes existing roles.
- An Owner starts a role from a template in the role form, then saves it with the normal `POST /roles`, so the
  escalation rule applies there.

**Modules:** `GET /v1/modules` (`MODULES.view`, platform) returns every module as a tree; `PATCH /v1/modules/{moduleId}`
(`MODULES.update`, platform) changes `module_name`, `description`, `sno` and `icon` only. Codes, routes, parents and
on/off stay fixed: the code and the web app depend on them, and switching a module off would lock everyone out of it.
`/me` follows on the next request.

**Not built:** endpoints for platform roles and platform staff beyond the Super Admin; creating, deleting or switching
off modules.
