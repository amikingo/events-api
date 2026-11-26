# Building brief: new Cheche accounts when adding staff, editing names (Phase 2e, step 4)

Copy everything below the line into the agent.

---

You are changing screens in **events-web** (`/Users/joedee/cheche-projects/Event_management/events-web`). The API is already built. Change the screens only. Same rules as every brief: read `AGENTS.md` and the Cheche UI docs first; never edit `components/ui/`; never touch the landing page (`app/(home)/page.tsx`, `app/(home)/layout.tsx`, `components/marketplace/home/*`, `components/marketplace/site-footer.tsx`); no API, migration, database, `.env` or git changes; stop and ask when the API differs; check at 375 px and in dark mode; run the typecheck and lint and report. **Never log, store or print a password.**

## API (under `/v1/organizations/{organizationId}`)

| Call | What's new |
|---|---|
| `POST /staff-assignments` | Optional `new_account: { firstname, middlename?, lastname, password }` (password 8 to 128 characters). When the mobile has no Cheche account, one is created with this password and the role is given. The reply adds `account_created: true \| false`. Without `new_account`, an unknown mobile is still 404 `central_account_not_found`. |
| `PATCH /staff-assignments/{assignmentId}/profile` | **New.** `{ firstname?, middlename?, lastname? }`: changes the person's names in their Cheche account. Needs *Staff Assignments › update*. Names only. 409 `central_auth_refused` when Cheche accounts refuse. |

## Changes

1. **Add staff** (`app/admin/access/assignments/[[...slug]]/add-staff-form.tsx`):
   - when the look-up answers 404 `central_account_not_found`, show "This number has no Cheche account yet. Create one for them:" with **First name**, **Middle name** (optional), **Last name** and **Password** (`PasswordInput`, 8 or more characters, with a *Generate* option is welcome if a component allows it; otherwise plain);
   - send them as `new_account` with the mobile and role;
   - **after a 201 with `account_created: true`**, show a one-time hand-over panel: "Give {name} these sign-in details: mobile {0911 223 344}, password {what you typed}. You won't see the password again." with a *Copy* button and *Done*. Keep the password only in the form's state; clear it when the panel closes;
   - when `account_created` is false, the usual "Staff assignment created" toast.
2. **Edit names** on the staff assignment's page (with *Staff Assignments › update*): an *Edit names* action opening a small `RecordForm` page (first, middle, last name). Toast "Names updated". Error 409 `central_auth_refused`: "Cheche accounts didn't accept this change. Try again later." Mobile is shown read-only with: "The mobile number can't be changed here."
3. Add `describeApiError` text for `central_auth_refused`.

## When you're done

Report the files you changed, the typecheck and lint results, screenshots (375 px and dark mode) of the new-account fields, the hand-over panel and the names form, and anything that didn't match the API.
