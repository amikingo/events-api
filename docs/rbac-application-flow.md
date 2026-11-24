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

Every organization created by `provision:organizer` starts with two roles (`src/utils/default-roles.ts`):

| Role | Grants |
|---|---|
| `OWNER` | `ORGANIZATIONS` view, update · `BRANCHES` view, create, update · `ROLES` view · `USER_ROLES` view |
| `VIEWER` | `ORGANIZATIONS` view · `BRANCHES` view |

Later phases add their modules to these templates and extend existing organizations through migrations. A
default role never gets a platform-only module (`MODULES`, `ROLE_TEMPLATES`).

Operational scripts. Each previews by default, writes only with `--confirm`, prints JSON, and loads `.env`, so the
project owner runs it:

```bash
npm run provision:organizer -- --name "Selam Events" --owner-user-id <uuid> [--slug selam-events] [--confirm]
npm run assign:staff -- --organization-slug selam-events --user-id <uuid> --role-code VIEWER [--branch-code ADDIS] [--confirm]
npm run dev:staff-token -- --user-id <uuid> [--assignment-id <uuid>]     # development only
```

- `provision:organizer` creates the organization, its `MAIN` branch, the two roles with their grants and the
  owner's organization-wide assignment, all in one transaction (`organizationProvisioningService`).
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

## Managing role assignments over HTTP (not built yet)

There are no endpoints for managing roles, role access or assignments yet (only the scripts above).
When they are built, these rules apply. Each is enforced in the service with a friendly error first; the
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
  *Open decision for when this is built:* how to mark a module as platform-only (for example a column on
  `module` set by migration), since `ORGANIZATIONS` is used at both levels.
