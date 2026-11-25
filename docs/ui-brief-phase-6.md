# Building brief: guest accounts and My Tickets (Phase 6 screens)

Copy everything below the line into the agent.

---

You are building screens in **events-web** (Next.js, at `/Users/joedee/cheche-projects/Event_management/events-web`). The API they call, **events-api**, is already built. Build the screens only.

## Rules

1. **Read `events-web/AGENTS.md` first and follow it exactly.** In particular:
   - this Next.js version differs from what you know, so read the guide in `node_modules/next/dist/docs/` before writing code;
   - use the Cheche UI library in `components/ui/`. Pick components with `.cheche-ui/choosing.md`, follow `.cheche-ui/patterns.md`, and look up props in `.cheche-ui/components.md`;
   - tokens only (no hex, no Tailwind palette), Lucide icons, `toast` for results and `Field error=…` for field errors.
2. **Never edit anything in `components/ui/`.** If a component can't do what you need, stop and ask.
3. **Never touch the landing page.** These files stay exactly as they are:
   - `app/(home)/page.tsx`
   - `app/(home)/layout.tsx`
   - `components/marketplace/home/*`
   - `components/marketplace/site-footer.tsx`

   The other pages in `app/(home)/` (`my-tickets/`, `account/` and the event page `events/[org]/[slug]/`) and everything in `app/auth/` may change.
4. **Don't touch:** events-api, any migration or database, and any `.env` file. Never read, print, log or store a token, password or SMS code. Tokens live in memory only; the refresh token is an HttpOnly cookie the browser handles by itself.
5. **Don't change git** (no commit, push, branch or stash).
6. **Stop and ask** when the API answers differently from this brief. Don't work around it in the screen.
7. **Copy rules:** plain words, sentence case, no "Oops", no exclamation marks. Buttons name the action ("Create account", "Send code", "Sign in").
8. **Dates:** Ethiopian date and time first, then Gregorian with a 12-hour time. Never 24-hour.
9. **Check every screen** at 375 px wide and in dark mode, then run the project's typecheck and lint. Report the results.

## What exists today

- `app/auth/attendee/attendee-auth-service.ts` **simulates** guest accounts in the browser: localStorage accounts (`cheche-events.auth.v1`), sessionStorage code challenges, a demo account "Hana Bekele", and a fixed demo code from `lib/marketplace/config.ts`. Its comment asks to keep the method names when it's connected.
- `/auth` is one page (`app/auth/auth-flow.tsx`, steps in `app/auth/steps/`). "Team sign-in" there is already real (staff).
- `app/(home)/my-tickets/page.tsx` is a static "Your ticket is your code" page. `app/(home)/account/page.tsx` renders `components/marketplace/account-view.tsx`, which saves to localStorage.
- `components/marketplace/public/register-form.tsx` registers through `registerForEvent` (`lib/api/public-events.ts`) without an account.
- `lib/api-client.ts` keeps only the **staff** token, and never sends a token on `/v1/public/` paths.
- Entry points outside the landing page: `components/marketplace/site-header.tsx`, `account-menu.tsx`, `mobile-nav.tsx`.

## 1. The guest token in `lib/api-client.ts`

Add a guest session next to the staff one. Don't change how staff requests behave.
- Keep the guest access token in module memory only.
- **Refresh:** `POST /v1/auth/customer/refresh` (cookie, `credentials: "include"`). The reply is a new session. On 401, the guest is signed out.
- **Send the guest token** as `Authorization: Bearer …` only on:
  - `/v1/customer/*`
  - `/v1/auth/customer/me`
  - the public registration POST (`/v1/public/organizations/{org}/events/{slug}/registrations`), when a guest is signed in.

  Never send it anywhere else, and never send the staff token on those paths.
- On a 401 with an unusable token, refresh once and retry, like the staff flow.
- One session at a time stays as today: signing in as a guest signs staff out, and the other way round (`app/auth/session.ts`).

## 2. Replace the simulated guest auth

Rewrite `app/auth/attendee/attendee-auth-service.ts` on the real API. Keep its method names. Remove the demo account, the demo code, and the localStorage and sessionStorage storage.

**API** (all `POST` unless noted; every body is JSON):

| Call | Body | Success |
|---|---|---|
| `/v1/auth/customer/signup` | `{ first_name, last_name, mobile, password }` | 201. A code was sent by SMS. |
| `/v1/auth/customer/signup/confirm` | `{ mobile, otp, password }` | 200, the session, and the guest is signed in |
| `/v1/auth/customer/signup/resend` | `{ mobile }` | 200. A new code was sent. |
| `/v1/auth/customer/code` | `{ mobile }` | 200. A sign-in code was sent. |
| `/v1/auth/customer/login/code` | `{ mobile, otp }` | 200, the session |
| `/v1/auth/customer/login/password` | `{ mobile, password }` | 200, the session |
| `/v1/auth/customer/logout` | none | 200. Clear the guest session. |
| `GET /v1/auth/customer/me` | | the guest: `{ id, mobile, firstname, middlename, lastname }` |

The session is `{ accessToken, tokenType: "Bearer", expiresIn, user: { id, mobile, firstname, middlename, lastname } }`. The mobile is sent as `09…` or `+251…` (`PhoneInput`). The code field is called **`otp`**.

**Screens (`app/auth/steps/`):**
- **Sign-in:** mobile, then *Send code* → the code step → `login/code`. Also offer "Use my password instead" → mobile and password → `login/password`.
  - 404 `account_not_found` → "There's no Cheche account with this number yet." with a link to create one (mobile filled in).
- **Sign-up:** first name, last name, mobile and password (**no email**: Cheche accounts have none here) → `signup` → the code step.
  - **409 `account_exists`** → show "You already have a Cheche account. Sign in" and switch to sign-in with the mobile filled in.
- **The sign-up code step:** the code, plus the password kept in the step's state from the form before (never stored) → `signup/confirm`.
  - A **"Send a new code"** link → `signup/resend`. If it's refused, show the API's message as it is. On 429, show the wait message from the API.
- **Forgot password:** offer "Sign in with a code instead", which opens the code sign-in with the mobile filled in. No password reset.
- After signing in, go to `/my-tickets`, as the code step does today.

**Errors:**

| Status and code | Where | Text |
|---|---|---|
| 400 `invalid_code` | The code field | The API's message ("The code is wrong or has expired" when it has none) |
| 401 `invalid_credentials` | The password field | "Invalid mobile number or password." |
| 409 `account_exists` | Sign-up | "You already have a Cheche account. Sign in", then switch to sign-in |
| 404 `account_not_found` | Sign-in | "There's no Cheche account with this number yet." plus *Create an account* |
| 429 `rate_limited` or `central_auth_rate_limited` | Toast | The API's message (for example "Too many codes were sent to this number. Wait 10 minutes and try again") |
| 400 `validation_error` | The fields named in `details.issues[].path`, or a toast | The issue's message |
| 503 `central_auth_unavailable` | Toast | "Cheche accounts can't be reached right now. Try again." |

## 3. Registering while signed in

In `components/marketplace/public/register-form.tsx`:
- When a guest is signed in, pre-fill first and last name from the account, and **show the mobile as read-only text** ("Your code will be sent to 0911 223 344"). Don't send `phone`: the API uses the account's mobile.
- Send the guest token on the POST (section 1). The `Idempotency-Key` rule stays as it is.
- **A 200 reply** with "You're already registered for this event" shows the registration and its code, the same as a new one, with that sentence.
- Signed out, the form works exactly as today (phone required).
- Add a quiet line under the form when signed out: "Have a Cheche account? Sign in to keep your tickets in one place." linking to `/auth`.

## 4. My Tickets (`app/(home)/my-tickets/page.tsx`)

**API:** `GET /v1/customer/registrations` with the guest token. It returns a list, upcoming first, then past. Each entry:

```
{ code, status: "CONFIRMED" | "CANCELLED", registered_at, cancelled_at,
  ticket_type: { code, name },
  event: { name, slug, starts_at, ends_at, timezone, status },
  organization: { name, slug } }
```

**Screen:**
- **Signed out:** keep today's message ("Your ticket is your code") and add *Sign in*.
- **Signed in:** two groups, **Upcoming** and **Past**. A past event is one whose `ends_at` (or `starts_at`) is before now.
  - Each ticket shows the event name (linking to `/events/{organization.slug}/{event.slug}`), the organizer's name, the date and time in the event's time zone (Ethiopian first, then Gregorian 12-hour), the ticket type, the **code** in large, easy-to-read text, and a `StatusPill` for the status.
  - Cancelled tickets show "Cancelled" and no code emphasis.
- **Empty state:** "No tickets yet", with *Browse events*.
- **A note under the list:** "Tickets you registered for without signing in don't appear here. Their code still works."
- Loading is a skeleton of the same shape.

## 5. Account (`app/(home)/account/page.tsx`, `components/marketplace/account-view.tsx`)

- Show the name and mobile from `GET /v1/auth/customer/me`, read-only, plus *Sign out* (`logout`).
- **Hide** the profile form, the notification switches and the city list: they have no backend.
- Signed out: redirect to `/auth`.

## 6. Header and menu

`account-menu.tsx`, `site-header.tsx` and `mobile-nav.tsx` read the real guest session (the guest's first name, *My tickets*, *Account*, *Sign out*). Don't change the footer: its links already point to the right pages.

## When you're done

Report:
- the files you changed;
- the typecheck and lint results;
- screenshots at 375 px and in dark mode of: sign-in (code), the code step, sign-up, the "already have an account" state, My Tickets (with tickets and empty), the register form signed in, and the account page;
- anything in this brief that didn't match the API.
