# Building brief: module administration and switched-off features (Phase 2e, step 6)

Copy everything below the line into the agent.

---

You are building screens in **events-web** (`/Users/joedee/cheche-projects/Event_management/events-web`). The API is already built. Build the screens only. Same rules as every brief:
- read `AGENTS.md` and the Cheche UI docs first;
- never edit `components/ui/`;
- never touch the landing page (`app/(home)/page.tsx`, `app/(home)/layout.tsx`, `components/marketplace/home/*`, `components/marketplace/site-footer.tsx`);
- no API, migration, database, `.env` or git changes;
- stop and ask when the API differs;
- check at 375 px and in dark mode;
- run the typecheck and lint, and report.

Create and edit are full pages (`RecordForm`); modals only confirm.

## 1. The Modules screen (Super Admin, `/access/modules`)

The screen exists today: a tree with name, description, order and icon editing. Extend it.

### API (platform scope)

| Call | Body | Reply |
|---|---|---|
| `GET /v1/modules` | | The tree. Each node is `{ id, code, module_name, description, parent_id, sno, icon, route_name, is_menu, is_permission, is_active, is_core, always_on, children }` |
| `POST /v1/modules` | `{ code, module_name, description?, parent_id?, sno?, icon?, route_name?, is_menu, is_permission }` | 201, the module |
| `PATCH /v1/modules/{moduleId}` | Any of `{ module_name, description, sno, icon, parent_id, route_name, is_menu, is_permission }` | 200, the module |
| `PATCH /v1/modules/{moduleId}/status` | `{ is_active }` | 200, the module; the message says what happened |

**Permissions** come from `/me` `permissions.MODULES`: view, create, update. Hide *New module* without `create`, and hide editing and switching without `update`.

### The tree

- Show every module, switched-off ones included, with a status pill (On / Off).
- **Badges:**
  - **Core** when `is_core`, with the tooltip "The app depends on this module. Its route and permission setting can't change."
  - **Always on** when `always_on`.
- **Kind:**
  - "Permission module" when `is_permission`;
  - "Link" when not a permission module and `route_name` is set;
  - "Menu group" when neither.

### New module (full page)

| Field | Rules |
|---|---|
| Code | Upper case letters, digits and `_`. Upper-case what the user types. Fixed after creation, with the hint "Can't be changed later." |
| Name | Required, up to 250 characters. |
| Description | Optional. |
| Parent | Optional. A picker of switched-on modules. Empty means the top level. |
| Order | A number, 0 or more. |
| Icon | A Lucide icon name. |
| Route | Optional, starting with `/`, e.g. `/reports/sales`. |
| Show in menu | A switch (`is_menu`). |
| Permission module | A switch (`is_permission`). Hint: "Platform roles can be given access to it. Organizations can't: only modules the app is built for can be given to an organization's roles." |

### Edit module (full page)

The same fields as *New module*, except:
- **Code** is shown read only.
- **When `is_core`,** *Route* and *Permission module* are read only, with the Core tooltip.
- **The parent picker** leaves out the module itself and all its submodules. The server refuses a loop anyway.

### Switch off / on

Use a `ConfirmDialog`.
- **Switching off:**
  - Dialog text: "Switch off {name}? Nobody will be able to use it, the Super Admin included, and it leaves every menu. Roles keep their access for when you switch it back on."
  - Hide the switch-off action when `always_on`, with the hint "The admin screens need this module, so it stays on."
- **Switching on:** "Switch on {name}? Everyone whose role gives access gets it back."

After any change, reload the tree and refetch `/me`, because the menu may have changed.

### Errors

| Code | Text |
|---|---|
| 400 `validation_error` with `issues[].code: "parent_cycle"` | "A module can't sit under itself or one of its own submodules." (on the Parent field) |
| 400 `issues[].code: "parent_inactive"` / `"parent_not_found"` | "Choose a switched-on parent." (on the Parent field) |
| 409 `conflict` with `details.field: "code"` | "Another module already uses this code." (on the Code field) |
| 409 `module_protected` | Show the server's message. It covers always-on modules and a core module's route or permission setting. |
| 409 `module_in_use` | "{details.grants} roles, templates or overrides still give access to this module. Remove those first." |
| 409 `invalid_module_state` | Show the server's message: switch off its submodules first, or switch on its parent first. |

## 2. Switched-off features everywhere

The server now says when an action is unavailable to everyone, not just to this role.

- **Menus:**
  - Keep building the menu from `/me` `navigation`. A switched-off module, and *Branches* in an organization without branches, are already left out.
  - Don't add your own rules for these. Remove any code that hid *Branches* by checking `has_branches` on the menu. Keep hiding branch pickers, columns and filters when `has_branches` is false, as before.
- **Organizations without branches:**
  - `permissions.BRANCHES` now shows everything `false` except `create`.
  - Don't call `GET …/branches` for these users.
  - Keep the existing *Add a branch* entry point, wherever it is today, and show it only when `permissions.BRANCHES.create` is true. After adding the first branch, refetch `/me`: *Branches* appears.
- **403 with a reason:** when a 403 `permission_denied` carries `details.reason` of `module_unavailable` or `feature_disabled`, say "This part of the app is switched off." instead of "You don't have permission". Put this in the shared error handling, not on each page.
- **Grids** (roles, templates, overrides and platform roles): no change. `grantable-modules`, `GET /v1/modules` and the role replies already leave switched-off modules out. Saving a role while a module is off keeps that module's access on the server.

## When you're done

Report:
- the files you changed;
- the typecheck and lint results;
- screenshots at 375 px and in dark mode of:
  - the module tree with badges;
  - *New module*;
  - *Edit module* for a core module (Route and Permission read only);
  - the switch-off dialog;
  - the menu of an organization without branches;
- anything that didn't match the API.
