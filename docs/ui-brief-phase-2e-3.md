# Building brief: roles made from templates (Phase 2e, step 3)

Copy everything below the line into the agent.

---

You are changing screens in **events-web** (`/Users/joedee/cheche-projects/Event_management/events-web`). The API is already built. Change the screens only. Same rules as every brief: read `AGENTS.md` and the Cheche UI docs first; never edit `components/ui/`; never touch the landing page (`app/(home)/page.tsx`, `app/(home)/layout.tsx`, `components/marketplace/home/*`, `components/marketplace/site-footer.tsx`); no API, migration, database, `.env` or git changes; stop and ask when the API differs; check at 375 px and in dark mode; run the typecheck and lint and report.

## API

| Call | What's new |
|---|---|
| `POST /v1/organizations/{organizationId}/roles` | Optional `role_template_id` (an active template). **Without `grants`** the server copies the template's grants; **with `grants`** it uses them. Either way the role remembers the template. 409 `role_template_inactive`. |
| Roles (`GET /roles`, `GET /roles/{id}`, replies) | Each role has `role_template: { id, code, name } \| null`. `GET /roles?role_template_id=` lists the roles made from one template. |
| `GET /v1/role-templates/{templateId}/roles` | **New, Super Admin.** `[{ id, code, name, is_active, organization: { id, name, slug } }]`: every organization's roles made from the template. |

## Changes

1. **Role form, "Start from a template"** (`app/admin/access/roles/[[...slug]]/role-form.tsx`): keep filling the form from the template, and **send `role_template_id`** with the role (with the grants as edited). Show the error for 409 `role_template_inactive`: "This template is switched off. Pick another one or build the role yourself."
2. **Role page and list:** when `role_template` is set, show "Made from {template name}" (a neutral `Pill` on the page; a small line in the list). Add a template filter to the role list when any role has one.
3. **Role template page (Super Admin)** (`app/admin/access/role-templates/[[...slug]]/`): a **Roles** tab listing `GET /v1/role-templates/{id}/roles`: organization, role name and code, status. Empty state: "No roles were made from this template yet." Keep the note: "Roles made from a template are copies. Editing a template never changes them."
4. Add `describeApiError` text for `role_template_inactive`.

## When you're done

Report the files you changed, the typecheck and lint results, screenshots (375 px and dark mode) of a role "Made from" a template and the template's Roles tab, and anything that didn't match the API.
