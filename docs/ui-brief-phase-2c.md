# Building brief: custom roles and organization management (Phase 2c screens)

Copy everything below the line into the agent.

---

You are building screens in **events-web** (Next.js, at `/Users/joedee/cheche-projects/Event_management/events-web`). The API they call, **events-api**, is already built. Build the screens only.

## Rules

1. **Read `events-web/AGENTS.md` first and follow it exactly.** In particular:
   - this Next.js version differs from what you know, so read the guide in `node_modules/next/dist/docs/` before writing code;
   - use the Cheche UI library in `components/ui/`. Pick components with `.cheche-ui/choosing.md`, follow `.cheche-ui/patterns.md`, and look up props in `.cheche-ui/components.md`;
   - tokens only (no hex, no Tailwind palette), Lucide icons, `toast` for results and `Field error=…` for field errors;
   - create and edit are full pages (`RecordForm`). Modals only confirm.
2. **Never edit anything in `components/ui/`.** If a component can't do what you need, stop and ask.
3. **Don't touch:** events-api, any migration or database, and any `.env` file. Never read or print a token or password.
4. **Don't change git** (no commit, push, branch or stash).
5. **Stop and ask** when the API answers differently from this brief. Don't work around it in the screen.
6. **Copy rules:** plain words, sentence case, no "Oops", no exclamation marks. Buttons name the action ("Create role", not "Submit").
7. **Check every screen** at 375 px wide and in dark mode, then run the project's typecheck and lint. Report the results.

## Files to start from

| What | File |
|---|---|
| Roles API client (read only today) | `lib/api/roles.ts` |
| Organizations API client | `lib/api/organizations.ts` |
| Error messages | `lib/api/errors.ts` (`describeApiError`) |
| Roles screen (list and detail, read only today) | `app/admin/access/roles/[[...slug]]/page.tsx` |
| Organizations screen and form | `app/admin/organizations/[[...slug]]/page.tsx`, `organization-form.tsx` |
| The look-up pattern to copy | `app/admin/access/assignments/[[...slug]]/add-staff-form.tsx`, `lib/api/staff.ts` |
| Permissions from `/me` | how existing screens hide actions (for example the assignments page) |

Every reply uses the existing envelope: `data`, `message`, and on errors `error: { code, message, details }`. `apiRequest` already handles it.

## 1. Roles

**API** (all under `/v1/organizations/{organizationId}`):

| Call | Body | Reply |
|---|---|---|
| `GET /roles` | | The roles: `{ id, code, name, description, is_active, grants: [{ module_code, module_name, view, create, update, delete, import, export, notify }] }` |
| `GET /roles/{roleId}` | | One role |
| `POST /roles` | `{ code, name, description?, grants: [{ module_code, view, create, update }] }` | 201, the role |
| `PATCH /roles/{roleId}` | Any of `{ name, description, grants }`. `grants` replaces the whole set: send every module to keep. `description: null` clears it. | 200, the role |
| `PATCH /roles/{roleId}/status` | `{ is_active }` | 200, the role |

**Add to `lib/api/roles.ts`:** `createRole`, `updateRole` and `changeRoleStatus`, with the types `RoleGrantInput` (`{ module_code, view, create, update }`), `RoleCreateInput` and `RoleUpdateInput`. Update the comment at the top, which says read only.

**Who sees what** (from `/me` `permissions.ROLES`):
- `view`: the list and detail;
- `create`: the *New role* button;
- `update`: *Edit role*, *Switch off* and *Switch on*.

**Screens:**
1. **Role list:**
   - each role's name, code, a status pill (active or switched off) and a short summary of what it may do;
   - a *New role* button (create permission) that opens `/access/roles/new`;
   - the empty state never shows: every organization has Owner and Viewer.
2. **Role page:**
   - name, code, description and status, plus the grant grid, read only;
   - *Edit role* opens `/access/roles/{id}/edit`;
   - *Switch off* or *Switch on* sits behind a `ConfirmDialog`. Text when switching off: "Staff can't be given this role while it's off. Staff who hold it must be given another role first."
   - **The Owner role (`code: "OWNER"`) is read only:** no edit or switch controls. Note: "The Owner role always has full access and can't be changed."
3. **Role form** (create and edit, `RecordForm`):
   - **Code:** create only; read only when editing. Help text: "Letters, digits and underscores. It can't be changed later." The API stores it in upper case.
   - **Name:** required, up to 250 characters.
   - **Description:** optional, up to 2000 characters.
   - **The grant grid:** one row per module, with *View*, *Create* and *Update* boxes. Offer only these boxes, with no others:

     | Module code | Allowed boxes |
     |---|---|
     | `ORGANIZATIONS` | View, Update |
     | `BRANCHES`, `ROLES`, `USER_ROLES`, `EVENTS`, `CUSTOMERS`, `REGISTRATIONS` | View, Create, Update |

     - **Row labels:** use `module_name` from the Owner role's `grants` (it holds every module above).
     - **Ticking Create or Update also ticks View;** unticking View clears the row.
     - **Hide the Branches row when the organization's `has_branches` is false.**
     - **Send** one entry per module, all three booleans, and only for rows with at least one box ticked.
   - **Buttons:** *Create role* or *Save changes*.

**Errors** (code → what to show):

| Status and code | Where | Text |
|---|---|---|
| 400 `validation_error` | Field errors from `details.issues[].path` (for example `body.name`, or `body.grants.2.create` for a grid row) | The issue's message, next to the field or row |
| 403 `grant_exceeds_own_access` | Toast | "You can't give access you don't have yourself ({module name} › {action})." Use `details.module_code` and `details.action`. |
| 409 `conflict`, `details.field: "code"` | Code field | "Another role already uses this code." |
| 409 `conflict`, `details.field: "name"` | Name field | "Another role already has this name." |
| 409 `role_locked` | Toast | "The Owner role can't be changed." |
| 409 `role_in_use` | Toast, or the confirm dialog | "{details.active_assignments} staff still have this role. Give them another role first, then switch it off." Add a link to Staff Assignments. |
| 403 `permission_denied` | Toast | "You don't have permission to do this." |

Changes apply on the next request. Nobody has to sign out.

**Staff Assignments (small change):** in the role picker of *Add staff* and *Change role*, list only active roles (`is_active: true`). Picking a switched-off role gives 409 `role_inactive`.

## 2. Organization name and description

**API:** `PATCH /v1/organizations/{organizationId}` now accepts `name` (1–255 characters) and `description` (up to 4000; `null` clears it), as well as the existing `country`, `timezone` and `default_currency`. The **slug can't be changed**: sending it gives 400.

**Screen:**
- add *Name* and *Description* to the organization's edit form (shown with `ORGANIZATIONS.update`, which Owners have);
- show the slug read only, with: "The web address can't be changed, so event links keep working.";
- in `lib/api/organizations.ts`, widen the update input to include `name` and `description`, and rename the success toast to "Organization updated".

## 3. Switching an organization off and on (Super Admin only)

**API:** `PATCH /v1/organizations/{organizationId}/status` with `{ is_active }`. Only the platform Super Admin may call it. Show it only when the signed-in assignment has no organization (`assignment.organization_id === null`). Anyone else gets 403.

**Screen:**
- on the organization's page, a *Switch off organization* or *Switch on organization* button;
- the button sits behind a `DestructiveDialog` for switching off and a `ConfirmDialog` for switching on;
- switch-off text: "Its staff won't be able to sign in or work, and its events disappear from the public site. Nothing is deleted; you can switch it back on.";
- show the state with a status pill in the organization list and on its page;
- the reply is the organization. Its toast is "Organization switched off" or "Organization switched on".

## 4. The first Owner when creating an organization (Super Admin)

**API:** `POST /v1/organizations` accepts an optional `owner_mobile` (`09…` or `+251…`) next to `organization`.
- **With it:** that person becomes the organization's Owner in the same step. The reply's `data.owner` is `{ user_id, assignment_id }`.
- **Without it:** `data.owner` is `null`, and the Owner can be added later through Staff Assignments.

**Screen:**
- in the create-organization form, an optional *Owner's mobile* field (`PhoneInput`), with the help text "They need a Cheche account. You can also add the Owner later in Staff Assignments.";
- there's **no Look up button** here: the look-up endpoint belongs to an existing organization. The create call checks the number itself and refuses with the errors below;
- after creating with an owner, the organization's page shows the Owner under Staff Assignments;
- **Success toast:** "Organization created" when there's no owner, or "Organization created with its Owner" when there is one.

**Errors:**

| Status and code | Text |
|---|---|
| 404 `central_account_not_found` | On the mobile field: "This number has no Cheche account yet. Ask them to sign up first, then try again." |
| 409 `conflict`, `details.field: "user_id"` | On the mobile field: "This person is already staff of another organization." |
| 409 `conflict`, `details.field: "slug"` | On the slug field, as today |
| 503 `central_auth_unavailable` | Toast: "Cheche accounts can't be reached right now. Try again." |

Nothing is created when any of these happen, so the form keeps its values.

## When you're done

Report:
- the files you changed;
- the typecheck and lint results;
- screenshots at 375 px and in dark mode of the role list, role form, Owner role page, organization edit form and switch-off dialog;
- anything in this brief that didn't match the API.
