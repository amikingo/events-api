# Building brief: staff filters, a role's members and counts (Phase 2e, step 1)

Copy everything below the line into the agent.

---

You are changing screens in **events-web** (Next.js, at `/Users/joedee/cheche-projects/Event_management/events-web`). The API is already built. Change the screens only.

## Rules

1. **Read `events-web/AGENTS.md` first and follow it exactly:** this Next.js version's guide in `node_modules/next/dist/docs/`; the Cheche UI library in `components/ui/` (pick with `.cheche-ui/choosing.md`, follow `.cheche-ui/patterns.md`, look up props in `.cheche-ui/components.md`); tokens only, Lucide icons, `toast` for results.
2. **Never edit anything in `components/ui/`.** If a component can't do what you need, stop and ask.
3. **Never touch the landing page:** `app/(home)/page.tsx`, `app/(home)/layout.tsx`, `components/marketplace/home/*`, `components/marketplace/site-footer.tsx`.
4. **Don't touch** events-api, migrations, databases or `.env` files. **Don't change git.**
5. **Stop and ask** when the API answers differently from this brief.
6. **Copy:** plain words, sentence case, no exclamation marks.
7. **Check** at 375 px and in dark mode; run the typecheck and lint and report the results.

## API (all under `/v1/organizations/{organizationId}`)

| Call | What's new |
|---|---|
| `GET /staff-assignments/{assignmentId}` | **New.** One assignment, the same shape as a list row (with `profile`). Needs *Staff Assignments › view*. |
| `GET /staff-assignments?is_active&role_id&branch_id&page&pageSize` | **New filters:** `role_id` (a role's members) and `branch_id`. |
| `GET /roles`, `GET /roles/{roleId}` | Each role now has `grant_count` (modules with at least one action) and `member_count` (active staff holding it). |
| `GET /v1/role-templates` and the organization's `GET /role-templates` | Each template now has `grant_count`. |
| `POST /staff-assignments`, `PATCH /staff-assignments/{id}`, `PATCH …/{id}/status` | **New refusal:** 409 `assignment_scope_conflict`: the person already has this role for the whole organization or for a branch. |

## Changes

1. **Staff Assignments** (`app/admin/access/assignments/[[...slug]]/`):
   - Add **Role** and **Branch** filters to the list (the branch filter only when the organization has branches). Send them as `role_id` and `branch_id`.
   - The assignment's own page loads it with `GET /staff-assignments/{assignmentId}` (add `getStaffAssignment` to `lib/api/staff.ts`) instead of finding it in the list, so a direct link works.
   - Show 409 `assignment_scope_conflict` on the role or branch field: "This person already has this role for the whole organization or for a branch. Use one or the other." Add the code to `describeApiError`.
2. **Roles** (`app/admin/access/roles/[[...slug]]/`):
   - The list shows **Modules** (`grant_count`) and **Staff** (`member_count`).
   - The role's page gets a **Members** tab: the staff list with `role_id` set, read-only, each row linking to the assignment. Empty state: "Nobody has this role yet."
3. **Role templates** (`app/admin/access/role-templates/[[...slug]]/`): the list shows **Modules** (`grant_count`).

## When you're done

Report the files you changed, the typecheck and lint results, screenshots (375 px and dark mode) of the staff list with filters, a role's Members tab and the role list, and anything that didn't match the API.
