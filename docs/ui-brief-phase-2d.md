# Building brief: permission overrides, role templates and modules (Phase 2d screens)

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
3. **Never touch the landing page:** `app/(home)/page.tsx`, `app/(home)/layout.tsx`, `components/marketplace/home/*` and `components/marketplace/site-footer.tsx`.
4. **Don't touch:** events-api, any migration or database, and any `.env` file. Never read or print a token or password.
5. **Don't change git** (no commit, push, branch or stash).
6. **Stop and ask** when the API answers differently from this brief. Don't work around it in the screen.
7. **Copy rules:** plain words, sentence case, no "Oops", no exclamation marks. Buttons name the action ("Save access", "Create template").
8. **Check every screen** at 375 px wide and in dark mode, then run the project's typecheck and lint. Report the results.

## Files to start from

| What | File |
|---|---|
| Staff assignments (list, detail, change role) | `app/admin/access/assignments/[[...slug]]/` (`page.tsx`, `change-role-form.tsx`) |
| Staff API client | `lib/api/staff.ts` |
| Role form (grant grid) | `app/admin/access/roles/[[...slug]]/role-form.tsx` |
| Roles API client | `lib/api/roles.ts` |
| Menu routes | `lib/constants/module-routes.ts` (`MODULE_ROUTES`), `lib/constants/modules.ts` (`ROUTE_MODULE_MAP`, `SIDEBAR_HIDDEN_MODULES`) |
| Menu icons | `lib/rbac/module-sidebar.ts` (`Boxes` and `Copy` are already mapped) |
| Error messages | `lib/api/errors.ts` (`describeApiError`, `grantExceedsOwnAccessMessage`) |

Every reply uses the existing envelope (`data`, `message`, and on errors `error: { code, message, details }`). `apiRequest` handles it.

## 1. Permission overrides (on the staff assignment's page)

**API** (under `/v1/organizations/{organizationId}`):

| Call | Body | Reply |
|---|---|---|
| `GET /staff-assignments/{assignmentId}/overrides` | | See below |
| `PUT /staff-assignments/{assignmentId}/overrides` | `{ overrides: [{ module_code, view?, create?, update?, export? }] }` | The same shape as GET |

The reply:

```
{ assignment_id, role: { id, code, name }, overridable: boolean,
  modules: [{ module_code, module_name, actions: ["view", "create", "update", "export"?],
              role:     { view, create, update, export },   // what the role gives
              override: { view, create, update, export },   // true, false or null (follow the role)
              effective:{ view, create, update, export } }] }
```

**Who sees what** (from `/me` `permissions.USER_ROLES`): `view` shows the card read-only; `update` allows editing.

**Screen:** an *Access* card on the staff assignment's page (the record view, not a modal):
- One row per module (`module_name`). For each action the module offers (`actions`), a three-way choice: **Follow role**, **Allow** or **Deny**. Pick the component in `.cheche-ui/choosing.md` (a `SegmentedControl` per cell fits).
- Next to each choice, show what the role gives in quiet text ("Role: yes" or "Role: no"). Mark a row whose `effective` differs from `role` so changes stand out.
- *Save access* sends **every** module, with `null` for "Follow role". The API replaces the whole set.
- **When `overridable` is false** (an Owner), show "Owners always have full access" and no controls.
- **On your own assignment** (its user is the signed-in person), show the card read-only with "You can't change your own access."
- Changes apply on the person's next request. Nobody has to sign out.

**The role-change warning:** after *Change role* (`PATCH /staff-assignments/{id}`), when the reply's `data.override_count` is above 0, show the API's `message` ("Role changed. This person still has 2 permission overrides: review them.") as a toast, with a link that scrolls to the Access card.

**Errors:**

| Status and code | Where | Text |
|---|---|---|
| 400 `validation_error` | The row named by `details.issues[].path` (`body.overrides.N.…`) | The issue's message |
| 403 `grant_exceeds_own_access` | Toast | "You can't give access you don't have yourself ({module} › {action})." |
| 409 `owner_not_overridable` | Toast | "Owners always have full access." |
| 409 `own_assignment` | Toast | "You can't change your own access. Ask another Owner." |
| 403 `permission_denied` | Toast | "You don't have permission to do this." |

## 2. Role templates (Super Admin)

**API:**

| Call | Body | Reply |
|---|---|---|
| `GET /v1/role-templates` | | All templates |
| `GET /v1/role-templates/{templateId}` | | One template |
| `POST /v1/role-templates` | `{ code, name, description?, for_new_organizations?, grants: [{ module_code, view, create, update, export? }] }` | 201, the template |
| `PATCH /v1/role-templates/{templateId}` | Any of `{ name, description, for_new_organizations, grants }` | 200, the template |
| `PATCH /v1/role-templates/{templateId}/status` | `{ is_active }` | 200, the template |

A template is `{ id, code, name, description, is_active, for_new_organizations, locked, grants: [{ module_code, module_name, view, create, update, export }] }`.

**Who sees it:** the Super Admin (`/me` `permissions.ROLE_TEMPLATES`).

**Screens** (copy the payments record template, as the roles screens do):
- **Menu:** add `"/access/role-templates": "/admin/access/role-templates"` to `MODULE_ROUTES` and the matching `ROUTE_MODULE_MAP` entry.
- **List:** name, code, a status pill, and a neutral `Pill` "For new organizations" when set.
- **Template page:** the grant grid, read-only.
  - **When `locked`** (OWNER), show "The Owner template always has full access and can't be changed" and no edit or switch controls.
  - Otherwise *Edit template*, and *Switch off* or *Switch on* behind a `ConfirmDialog`.
- **Form** (`RecordForm`, create and edit):
  - code (create only; letters, digits and underscores; fixed later), name, description;
  - a *For new organizations* switch, with the help text "New organizations get a role made from this template. Existing organizations don't change.";
  - the same grant grid as the role form (reuse its module list and rules, including Export on Guests only).
- **A note on every template page:** "Roles made from a template are copies. Editing a template never changes them."

**Errors:** 400 `validation_error` on the field or grid row; 409 `conflict` with `details.field` `code` ("Another template already uses this code.") or `name` ("Another template already has this name."); 409 `role_locked` ("The Owner template can't be changed.").

## 3. Start a role from a template (role form)

**API:** `GET /v1/organizations/{organizationId}/role-templates` lists the **active** templates (same shape), for people with *Roles › create*.

**Screen:** on the **New role** form only, a *Start from a template* `Select` above the grid. Choosing one fills the name, description and grid from the template. Everything stays editable, and saving uses the normal `POST /roles`. If the API answers 403 `grant_exceeds_own_access`, show the existing message.

## 4. Modules (Super Admin)

**API:**

| Call | Body | Reply |
|---|---|---|
| `GET /v1/modules` | | Every module as a tree: `{ id, code, module_name, description, parent_id, sno, icon, route_name, is_menu, is_permission, is_active, children: [...] }` |
| `PATCH /v1/modules/{moduleId}` | Any of `{ module_name, description, sno, icon }` | 200, the module (without children) |

**Screens:**
- **Menu:** add `"/access/modules": "/admin/access/modules"` to `MODULE_ROUTES` and `ROUTE_MODULE_MAP`.
- **List:** the tree, with containers as group headers and their modules indented: name, code, order (`sno`), icon (rendered through `lib/rbac/module-sidebar.ts`), and a status pill.
- **Edit form:** name, description, order (a number) and icon name (text, with help "A Lucide icon name, such as CalendarDays"). Code, route and status are shown read-only with: "Codes, routes and status are fixed: the app depends on them."
- After saving, refresh the session (`/me`), so the sidebar shows the new name and order.

## 5. Menu

Add `USER_MODULE_ACCESSES` to `SIDEBAR_HIDDEN_MODULES`. Overrides live on the staff page.

## When you're done

Report:
- the files you changed;
- the typecheck and lint results;
- screenshots at 375 px and in dark mode of: the Access card (editable, Owner, own assignment), the role-change toast, the template list, page and form, the role form with *Start from a template*, and the modules tree and form;
- anything in this brief that didn't match the API.
