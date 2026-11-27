# Building brief: profiles, passwords and the payment return (Phase 10)

Copy everything below the line into the agent. It doesn't depend on the Phase 8 or 9 briefs.

---

You are changing screens in **events-web** (Next.js, at `/Users/joedee/cheche-projects/Event_management/events-web`). The API is already built. Change the screens only.

## Rules

1. **Read `events-web/AGENTS.md` first and follow it exactly:**
   - this Next.js version's guide in `node_modules/next/dist/docs/`;
   - the Cheche UI library in `components/ui/`: pick components with `.cheche-ui/choosing.md`, follow `.cheche-ui/patterns.md`, and look up props in `.cheche-ui/components.md`;
   - tokens only, Lucide icons, and `toast` for results.
2. **Never edit anything in `components/ui/`.** If a component can't do what you need, stop and ask.
3. **Never touch the landing page:** `app/(home)/page.tsx`, `app/(home)/layout.tsx`, `components/marketplace/home/*`, `components/marketplace/site-footer.tsx`.
4. **Don't touch** events-api, migrations, databases or `.env` files. **Don't change git.**
5. **Stop and ask** when the API answers differently from this brief.
6. **Copy:** plain words, sentence case, no exclamation marks.
7. **Dates:** a date of birth is a plain date (`YYYY-MM-DD`). Show it with the Ethiopian date first, then the Gregorian date. Never a 24-hour clock anywhere.
8. **Passwords** are never shown back, logged or kept after the request.
9. **Check** at 375 px and in dark mode; run the typecheck and lint and report the results.

## API

All replies use the usual envelope (`data`, `message`); errors carry `error.code` and, for form errors, `error.details.issues[]` with `path` and `code`.

### A staff member's own account (Bearer staff token)

- **`PUT /v1/auth/staff/profile`** with `{ firstname, middlename?, lastname }`.
  - `middlename: ""` clears it, and leaving it out keeps it.
  - The reply is `{ profile, changed, access_token, expires_in }`. **Replace the staff access token in memory with `access_token`**, because the token carries the names shown in the header. If `changed` is false, nothing was sent ("Nothing changed").
  - Errors: 409 `central_auth_refused` ("Cheche accounts didn't accept the change. Try again later."); 503 `central_auth_unavailable`.
- **`PUT /v1/auth/staff/password`** with `{ old_password, new_password }`.
  - `new_password` must be 8 to 128 characters and different from the old one.
  - A wrong current password is **400 with issue code `wrong_password` on `body.old_password`**. Show "The current password is wrong" on that field and **don't sign the person out**.
  - 429 `rate_limited`: too many tries, so wait a minute.
  - Success: `{ updated: true }`. The session stays signed in.

### Forgot password (no login)

- **`POST /v1/auth/staff/forgot-password`** with `{ mobile }` (`09…`, `07…` or `+251…`).
  - **The reply is always 200 `{ sent: true, message }`**, whether or not the mobile belongs to staff. Show `message` and go to the code step every time. Never say "no account found".
  - 429: too many codes for this number, so wait 10 minutes.
- **`POST /v1/auth/staff/reset-password`** with `{ mobile, otp, new_password }`.
  - 400 `invalid_code`: "The code is wrong or has expired." Offer *Send a new code*.
  - Success: `{ reset: true }`. Go to staff sign-in with the mobile filled in and the toast "Password changed. Sign in with your new password."

### Editing a staff member (admin, Bearer staff token)

- **`GET /v1/organizations/{organizationId}/staff-assignments/{assignmentId}/profile`** (*Staff Assignments › view*) returns `{ firstname, middlename, lastname, mobile, email, sex, date_of_birth }`. `sex` is `MALE`, `FEMALE` or null.
- **`PATCH …/staff-assignments/{assignmentId}/profile`** (*Staff Assignments › update*) takes any of `firstname`, `middlename`, `lastname`, `email`, `sex` (`MALE`/`FEMALE`) and `date_of_birth` (`YYYY-MM-DD`, a real past date).
  - `""` or `null` clears an optional field.
  - **Send only the fields the admin changed.**
  - The mobile, status, PIN and password can't be changed here (400).
  - The reply is the assignment plus `profile` and `changed`.
  - Errors: 409 `central_auth_refused` ("Cheche accounts didn't accept the change", **not** a sign-out); 404; 503.

### A guest's own names (Bearer guest token)

- **`PUT /v1/auth/customer/profile`** with `{ firstname, middlename?, lastname }`. The reply is the profile `{ id, mobile, firstname, middlename, lastname }`.
- Afterwards, **refresh the guest session** (`POST /v1/auth/customer/refresh`) so the token carries the new names.

### The payment return

- After paying, Cheche Pay sends the buyer back to the address the server is configured with. By default that's the order page `/orders/{reference}`, but it may carry `?tx_ref=…` (or `?reference=…&tx_ref=…`).
- **The order page must ignore extra query values** and keep calling `POST /v1/public/orders/{reference}/check` with the order token, as it does now.
- No new endpoint. The server now also confirms payments by itself when the buyer never comes back.

## Changes

1. **Staff, *My profile*** (open it from the user menu in the admin header):
   - a form with first, middle and last name, prefilled from the signed-in user;
   - *Save* calls `PUT /v1/auth/staff/profile`, replaces the token, and updates the header name;
   - the mobile is shown read-only, with the hint "Your mobile is your sign-in. It can't be changed here."
2. **Staff, *Change password*** (on the same page, its own card):
   - fields: current password, new password, confirm new password (the confirmation is checked in the browser only);
   - put `wrong_password` on the current-password field;
   - on success, toast "Password changed" and clear the fields.
3. **Staff sign-in, *Forgot password?***:
   - wire the existing `app/auth/steps/forgot-step.tsx` and `reset-step.tsx` for staff to the two endpoints above: mobile, then code and new password;
   - the copy after sending is the API's `message`;
   - keep the attendee flow as it is.
4. **Admin, *Staff Assignments* › a staff member › *Edit details*** (needs *Staff Assignments › update*; hide the button otherwise):
   - load `GET …/profile`;
   - fields: first, middle and last name, email, sex (a select: *Not set*, *Male*, *Female*) and date of birth (a date picker that doesn't allow future dates);
   - the mobile is read-only;
   - send only the changed fields, and clearing a field sends `""`;
   - on success, toast "Details saved" and refresh the row's name.
5. **Attendee, the account page** (`app/(home)/account/page.tsx`, not the landing page): add *Edit name* (first, middle, last), then refresh the session.
6. **Buyer, the order page:** make sure `?tx_ref=` or `?reference=` in the address changes nothing.
7. **Errors in `describeApiError`:**
   - `central_auth_refused`: "Cheche accounts didn't accept the change. Try again later."
   - `wrong_password` (issue code): "The current password is wrong."
   - `invalid_code`: "The code is wrong or has expired."

## When you're done

Report:
- the files you changed;
- the typecheck and lint results;
- screenshots at 375 px and in dark mode of:
  - *My profile* with both cards;
  - the wrong-current-password error;
  - forgot password: the mobile step and the code step;
  - *Edit details* for a staff member;
  - the attendee's *Edit name*;
- anything that didn't match the API.
