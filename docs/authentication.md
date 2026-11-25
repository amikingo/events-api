# Authentication

## Model

- **Central Auth** owns identity: password login, OTP, refresh tokens. This API never stores passwords.
- **Staff**: after Central Auth login, the API loads the user's active local assignments (`user_role`) and mints
  its **own** short-lived access token (HS256, `APP_AUTH_TOKEN`, `iss`/`aud` = `events_api`,
  `token_type = staff_access`, `sub` = Central Auth user id, claims `assignment_id`, `role_id`,
  `organization_id`, `branch_id`, profile names). TTL = min(`APP_TOKEN_TTL_SECONDS`, upstream remaining lifetime).
- **Customers** (when needed): the Central Auth access token itself, verified with `APP_AUTH_TOKEN`
  (`iss = auth_api`, `token_type = access`).
- One shared secret, like bookings_api: `APP_AUTH_TOKEN` (auth-cheche's secret, same name there) both verifies
  Central Auth tokens and signs this API's own tokens. Only these checks keep the three token types apart:
  - Central token: issuer `auth_api` and `token_type = access`.
  - Staff token: issuer and audience `events_api` and `token_type = staff_access`.
  - Central-session confirmation: issuer and audience `events_api`, `token_type = staff_central_session`, and the
    matching refresh-token hash.

  See "Known risk / later" below.

## Endpoints

| Endpoint | Notes |
|---|---|
| `POST /v1/auth/staff/login` `{ mobile \| email, password, device_id?, device_name?, platform? }` | Exactly one of `mobile` or `email`. auth-cheche sign-in: `POST /v1/users/signin/password` (mobile) or `POST /v1/users/signin/email` (email; only for accounts that have an email in auth-cheche), **without** `?service_id=`, like bookings_api (with it, auth-cheche answers `403 User is not registered for this service` for accounts not registered to that service; access is decided by this API's `user_role` rows instead). PIN sign-in is legacy and a body with `pin` gets 400 → local token in JSON; refresh token **only** in the HttpOnly `events_staff_refresh` cookie (`Path=/v1/auth/staff`). Also sets the `events_staff_central_session` cookie (see below). Rejects upstream logins without a refresh token. Errors: see "Central Auth refusals" below. |
| `POST /v1/auth/staff/refresh` `{ assignment_id? }` | Reads the cookies only. Rate-limited, `Cache-Control: no-store`, Origin must be trusted. Skips Central Auth while the central-session cookie is valid (see below); assignments are re-read from the DB on every refresh. Requires `assignment_id` when several assignments are active (`409 staff_context_required`). auth-cheche rotates the refresh token on every Central refresh; the new one replaces the cookie. Session-ending failures clear both cookies. |
| `POST /v1/auth/staff/logout` | Clears both cookies first, then revokes the Central Auth session with `POST /v1/auth/logout` `{ refresh_token }` (no Bearer: staff hold only this API's token). Best effort: a Central failure is logged without token values and never blocks logout. `data.revoked` is `true` only when Central confirmed; `false` when it failed or no cookie was sent. Same rate limit, Origin check and `no-store` as refresh. |
| `GET /v1/auth/staff/me` | Revalidates the assignment from the DB; returns user, assignment, assignments, flat `permissions`, nested `navigation`. Never calls Central Auth. |
| `POST /v1/auth/staff/switch-assignment` `{ assignment_id }` | Re-mints the token for another active assignment. This is how a person with several roles changes what they may do: permissions are checked for the token's assignment only (see `docs/rbac-application-flow.md`). |

## Central Auth refusals

| auth-cheche answers | Client sees | Why |
|---|---|---|
| Login or refresh refused: 400, 401, 403 (unverified / not registered for this service), 404 (no such user) | `401 invalid_credentials`, always "Invalid mobile number, email or password" | The screen never learns whether the account exists, is unverified or is not registered for Events. The real reason is in the server log ("Request rejected", `cause: "Central Auth <status>: <text>"`). On refresh this becomes `refresh_token_invalid` and both cookies are cleared. |
| 429 (per-IP rate limit, or account locked after failed attempts) | `429 central_auth_rate_limited` | |
| 5xx, timeout, network failure | `503 central_auth_unavailable` | |
| Not JSON or an unexpected shape | `502 central_auth_malformed_response` | |

auth-cheche puts its error text in `error` (standard), `response` (OTP endpoints) or `message` (429); all three
are read. Two auth-cheche behaviours to know:

- Its rate limit is 5 requests per second **per IP**, and every call from this API comes from the server's IP, so
  all staff logins and Central refreshes share one budget (the central-session cookie removes most refresh calls).
- A sign-in attempt on an unverified account makes auth-cheche resend an OTP SMS.

## Staff central session (fewer Central Auth calls)

After login and after each successful Central refresh, the API signs a small "Central Auth confirmed this
person" token and stores it in the HttpOnly `events_staff_central_session` cookie (same path and options as
the refresh cookie).

- Signed with `APP_AUTH_TOKEN`, `token_type = staff_central_session`, `iss`/`aud` = `events_api`. Every token
  check requires its own exact `token_type`, so it can never pass as a staff access token or a Central token.
- Claims: `sub` (user id), `central_exp` (the Central access token's expiry), profile names and mobile, and
  `refresh_token_hash` (SHA-256 of the refresh token it was issued with). It only counts together with that
  same refresh cookie.
- Lifetime: min(`AUTH_CENTRAL_SESSION_TTL_SECONDS`, Central expiry − 5 minutes). `0` turns the feature off.
- On refresh: valid confirmation → Central Auth is not called and neither cookie changes. Missing, expired,
  tampered or mismatched → Central refresh as usual and a new confirmation. Assignments are always re-read.
- Trade-off: for up to the TTL (default 6 hours), refresh does not notice a session ended at Central Auth
  (password change, logout elsewhere, disabled account). Removing the person's assignment here still takes
  effect at their next refresh.

## Request identity

`req.auth` is the only identity source: `{ kind: "staff", userId, assignmentId, roleId, organizationId, branchId,
profile, expiresAt }` or `{ kind: "customer", userId, token, profile, expiresAt }`. It is set only by
`requireStaffAuthentication` / `requireCustomerAuthentication` / `optionalCustomerAuthentication`. No route reads
identity from body or query.

## Configuration

Required: `CENTRAL_AUTH_API` (base URL **without** `/v1`, e.g. `https://auth.cheche.et/api`; the client adds
`/v1/...` and startup refuses a trailing `/v1`), `APP_AUTH_TOKEN`, `CENTRAL_AUTH_SERVICE_ID` (not sent on sign-in
since 25 November 2026; kept for creating accounts with `create-verified`, below).
Optional: `APP_TOKEN_TTL_SECONDS`, `CENTRAL_AUTH_TIMEOUT_MS`, `AUTH_REFRESH_COOKIE_SECURE` (default: on in
production), `AUTH_REFRESH_COOKIE_SAME_SITE`, `AUTH_REFRESH_COOKIE_DOMAIN`, `AUTH_REFRESH_TTL_SECONDS`,
`AUTH_REFRESH_TRUSTED_ORIGINS` (required in production for browser refresh/logout),
`AUTH_REFRESH_COOKIE_PATH_PREFIX` (proxy path prefix such as `/api`, put in front of every auth cookie path;
must look like `/segment[/segment]`, no `//`, no trailing `/`; checked at startup),
`AUTH_CENTRAL_SESSION_TTL_SECONDS` (default 21600; `0` = ask Central Auth on every refresh).

## Known risk / later

One shared secret (`APP_AUTH_TOKEN`) is a deliberate choice for now, matching bookings_api.

- **The service token (Phase 2b):** for staff lookups (`GET /v1/users/get-user-by-mobile` and `POST /v1/users/specific_users`), this API signs a short auth-cheche access token of the system user (`auth_role: super_admin`, our service id, valid for 5 minutes) with the shared secret, exactly as bookings_api does. It's built only in `src/clients/central-auth.client.ts`, for one request at a time, and is never logged or returned. It works only because of the shared secret, so splitting the secret later also needs auth-cheche to issue this API a real service credential.
- **A refused service token** (auth-cheche answers 401 or 403) reaches staff as 503 `central_auth_unavailable`, because it's a configuration problem, never theirs.

- **The risk:** any service holding `APP_AUTH_TOKEN` can sign a staff token for this API, for any person and any
  role. It also works the other way: tokens this API signs carry a signature other Cheche services trust, so
  those services keep them out only through their own `token_type` / issuer checks (this API never issues
  `token_type = access` or `refresh`).
- **What protects us today:** the token checks listed under Model. `tests/auth-token.service.test.ts` proves
  that, with the shared key, none of the three token types passes as another.
- **Splitting it out later:** add a new secret setting in `src/config/env.ts`, point `appTokenSecret` in
  `src/config/auth.ts` at it, and add a startup check that it differs from `APP_AUTH_TOKEN`. No other code
  changes. Staff do not need to log in again: their next refresh issues new tokens signed with the new secret.

## Planned Central Auth integrations (not built yet)

None of these exist yet. When one is built, follow the rules below: they match bookings_api and each one
prevents a known failure. All of them go through `src/clients/central-auth.client.ts` and use the **service
token** issued by Central Auth (never a token this API signs itself, see blueprint §17).

### Creating staff accounts

- `POST /v1/users/create-verified?service_id=<CENTRAL_AUTH_SERVICE_ID>` with the service token. Body: the names,
  `mobile`, `password`.
- `409` means the account already exists. Treat it as "existing account", not as a failure.
- Afterwards, confirm the account is registered to our service: check `service_ids` in the response first, then
  `GET /v1/users/{id}`. If our service is missing, raise a partial-provisioning error.
  *Why:* Central Auth refuses password sign-in for a service the account isn't registered to, so the staff
  member would exist but could never log in.

### Reading users

- `POST /v1/users/specific_users` with the service token.
- Parse leniently (`z.looseObject`, field by field):
  - names may arrive as `{ en, am }` objects: keep both, never drop them;
  - mobiles are normalized to `+2519XXXXXXXX` (`src/utils/mobile.ts`);
  - `"1"` / `"true"` become booleans;
  - one field with an odd shape must not make the whole user disappear: fall back to `null` for that field.

### Editing a staff member's details

- `PUT /v1/users/{id}` with the service token.
- Allowed fields: names, email, sex, date of birth. Send only the fields that changed.
- **Never** mobile, status, PIN or password.
  *Why:* a Central Auth account is the same person in every Cheche app. Changing the mobile here would let
  someone take over the account everywhere through an OTP password reset.
- A `401`/`403` from Central becomes a "Central Auth refused" conflict (`409`), not "your session expired":
  the staff member's own session is fine, Central refused the service call.

### Forgot password

- `POST /v1/users/reset-password` with `{ mobile, otp, new_password }`.
- Map "OTP expired" and "invalid OTP" to their own stable error codes (one `AppError` class each), so the screen
  can tell the user what to do.
