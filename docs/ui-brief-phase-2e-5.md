# Building brief: platform roles and platform staff (Phase 2e, step 5)

Copy everything below the line into the agent.

---

You are building screens in **events-web** (`/Users/joedee/cheche-projects/Event_management/events-web`). The API is already built. Build the screens only. Same rules as every brief: read `AGENTS.md` and the Cheche UI docs first; never edit `components/ui/`; never touch the landing page (`app/(home)/page.tsx`, `app/(home)/layout.tsx`, `components/marketplace/home/*`, `components/marketplace/site-footer.tsx`); no API, migration, database, `.env` or git changes; stop and ask when the API differs; check at 375 px and in dark mode; run the typecheck and lint and report. Create and edit are full pages (`RecordForm`); modals only confirm. Never log, store or print a password.

## Who sees these screens

Only someone signed in with a **platform** assignment (`/me` `assignment.organization_id === null`) whose permissions allow it at platform scope: the Super Admin, or platform staff given *Roles* / *Staff Assignments*. Put them under a **Platform** group in the admin menu (the same place as Role Templates and Modules), not under an organization.

## API (all under `/v1/platform`)

| Call | Body | Reply |
|---|---|---|
| `GET /roles` | | Platform roles: `{ id, code, name, description, is_active, grant_count, member_count, grants: [...] }` |
| `POST /roles` | `{ code, name, description?, grants }` | 201, the role |
| `GET /roles/{roleId}` | | One role |
| `PATCH /roles/{roleId}` | Any of `{ name, description, grants }` (`grants` replaces the set) | 200 |
| `PATCH /roles/{roleId}/status` | `{ is_active }` | 200 |
| `GET /staff-assignments?is_active&role_id&page&pageSize` | | Platform staff (same shape as tenant staff, `branch` always null) |
| `POST /staff-assignments` | `{ mobile, role_id, new_account? }` | 201 given / 200 already had it; `account_created` |
| `GET /staff-assignments/{id}` | | One |
| `PATCH /staff-assignments/{id}` | `{ role_id }` | 200 |
| `PATCH /staff-assignments/{id}/status` | `{ is_active }` | 200 |
| `DELETE /staff-assignments/{id}` | | 204 |

Grants use the same shape as tenant roles (all 7 boxes), but a platform role may hold **any** module, platform modules (Modules, Role Templates, Permission Overrides) included. Build the platform grid from `GET /v1/modules` (permission modules, `is_permission: true`, active), with all 7 boxes on every row.

## Screens

1. **Platform › Roles**: list (name, code, status pill, Modules count, Staff count) → role page (read-only grid, *Edit role*, *Switch off/on* behind a `ConfirmDialog`) → role form (code on create only, name, description, the platform grid).
   - **`SUPER_ADMIN` is read-only:** "The Super Admin role always has full access and can't be changed."
   - A note on every platform role: "A platform role's access to organization modules applies in every organization."
2. **Platform › Staff**: list (name, mobile, role, status) → assignment page (*Change role*, *Switch off/on*, *Delete* behind a `DestructiveDialog`) → *Add platform staff* (mobile, role; the same "no Cheche account yet → create one" fields and one-time password hand-over as tenant *Add staff*).
   - Hide *Change role*, *Switch off* and *Delete* on your own assignment.

## Errors

| Code | Text |
|---|---|
| 409 `role_locked` | "The Super Admin role can't be changed." |
| 409 `role_in_use` | "{n} platform staff still have this role. Give them another role first." |
| 409 `last_super_admin` | "The platform must keep at least one active Super Admin." |
| 409 `own_assignment` | "You can't change your own platform access. Ask another Super Admin." |
| 409 `conflict` with `details.field: "user_id"` | "This person is staff of an organization, so they can't be platform staff." |
| 403 `grant_exceeds_own_access` | "You can't give access you don't have yourself ({module} › {action})." |
| 404 `central_account_not_found` | Show the new-account fields (as tenant *Add staff*). |

## When you're done

Report the files you changed, the typecheck and lint results, screenshots (375 px and dark mode) of the platform role list, role form, the read-only Super Admin role, the platform staff list and the add form, and anything that didn't match the API.
