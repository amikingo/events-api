# Building brief: all 7 actions, grids from the API, deleting assignments (Phase 2e, step 2)

Copy everything below the line into the agent.

---

You are changing screens in **events-web** (`/Users/joedee/cheche-projects/Event_management/events-web`). The API is already built. Change the screens only. Follow the same rules as every brief: read `AGENTS.md` and the Cheche UI docs first; never edit `components/ui/`; never touch the landing page (`app/(home)/page.tsx`, `app/(home)/layout.tsx`, `components/marketplace/home/*`, `components/marketplace/site-footer.tsx`); no API, migration, database, `.env` or git changes; stop and ask when the API differs; check at 375 px and in dark mode; run the typecheck and lint and report.

## API (under `/v1/organizations/{organizationId}`)

| Call | What's new |
|---|---|
| `GET /grantable-modules` | **New.** `[{ module_code, module_name, sno, actions }]`: the modules and boxes the grids may offer. Needs *Roles › view* or *Staff Assignments › view*. |
| Role, template and override grants | **All 7 boxes:** `view, create, update` always sent; `delete, import, export, notify` may be sent too. Organizations never offers create or delete. |
| `DELETE /staff-assignments/{assignmentId}` | **New.** Deletes the assignment and its permission overrides; **204**. Needs *Staff Assignments › delete*. Refusals: 409 `last_owner_assignment`, 409 `own_assignment`. |

## Changes

1. **Build every grid from `GET /grantable-modules`** (add `listGrantableModules` to `lib/api/roles.ts`), instead of the hard-coded `GRANT_MODULES` in `app/admin/access/_components/grant-grid.tsx`:
   - one row per module, in `sno` order, with exactly the boxes in its `actions`;
   - the grid gets **seven columns**: View, Create, Update, Delete, Import, Export, Notify. A box a module doesn't offer shows "—";
   - ticking any other box also ticks View; unticking View clears the row (as today);
   - `toGrantPayload` sends all seven for every module, **hidden rows included** (keep the comment: a hidden Branches row must still send what the role holds);
   - the same list feeds the role form, the template form and the staff Access card (overrides: all seven actions, Follow role / Allow / Deny);
   - remove the Guests-only Export hint; keep a short legend under the grid: "Delete, import and notify take effect where a screen offers them."
2. **Delete an assignment** on the staff assignment's page (only with *Staff Assignments › delete*, from `/me` `permissions.USER_ROLES.delete`):
   - a *Delete assignment* action behind a `DestructiveDialog`: "This removes {name}'s {role} role and their permission overrides for good. Switch it off instead if they may come back.";
   - not shown on your own assignment;
   - on 204, toast "Assignment deleted" and go back to the list;
   - errors: 409 `last_owner_assignment` "The organization must keep at least one active Owner."; 409 `own_assignment` "You can't delete your own assignment. Ask another Owner."

## When you're done

Report the files you changed, the typecheck and lint results, screenshots (375 px and dark mode) of the 7-column role grid, the Access card and the delete dialog, and anything that didn't match the API.
