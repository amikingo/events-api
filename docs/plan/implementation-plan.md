# Events API — implementation plan

Version 1 · 24 November 2026 · Backend first

This file is the working plan for Claude Code. Work **one phase at a time**. Each phase ends with a short report and a demo; the next phase starts only after that phase is verified.

How to use it:

- **Phase 0:** done (24 November 2026). The project lives in the repository `github.com/amikingo/events-api`. Next is Phase 1.
- **Later phases:** say: *"Carry out Phase N of docs/plan/implementation-plan.md. Do not start Phase N+1."*

---

## Fixed decisions (do not re-open during implementation)

| Topic | Decision |
|---|---|
| Starting point | The verified TypeScript starter from the `ts-backend-blueprint` skill (derived from `bookings_api`). Node 24, Express 5, TypeScript 6 (strict, ESM), Sequelize 6, PostgreSQL, Umzug migrations, Zod 4, `node:test`. |
| Project identity | Folder `events-api`, slug `events`, title `Events API`, **no table prefix**. |
| Architecture rules | The generated project's `AGENTS.md` and `docs/architecture/backend-module-standard.md` are binding. |
| Identity | Staff log in through Central Auth (**auth-cheche**). The API never stores credentials, only the Central Auth `user_id`. |
| Product behaviour (phases 3–5) | The *MVP 1 product and schema specification* of 23 November 2026. Review suggestions made after it are backlog, not scope. |
| Infrastructure for now | Local PostgreSQL: the PostgreSQL 17 already installed with Homebrew on the developer's machine. No Docker, CI or devcontainer files until the real repository exists (it brings its own). Every connection detail lives in `.env`, so moving to the real repository and database later changes no code. |

## What only the project owner can provide

These are needed for the **live** checks only. Building and automated tests use test doubles until they arrive; live checks are reported as *pending* until then.

1. The auth-cheche base URL for development.
2. The shared JWT secret (auth-cheche's `APP_AUTH_TOKEN`).
3. A `service_id` registered in auth-cheche for the Events product.
4. Test accounts (mobile, password), ideally three: one future owner, one future viewer, one with no role.

## Rules for every phase

- Follow `AGENTS.md`. Read the closest existing module (`branch`) before writing a new one, and copy its shape.
- **Databases and `.env`:** the agent never runs migrations, seeds, database-connected tests (`TEST_DATABASE=1`), or scripts that load `.env` (`dev`, `db:migrate*`, `bootstrap:super-admin` and the scripts added later). It writes the files and gives the exact commands; the project owner runs them, against `events_dev` and `events_test` only. Integration tests migrate **down to zero** at start and end, so they run against `events_test` only, never `events_dev`.
- **Git:** the project lives in the repository `github.com/amikingo/events-api`. The agent runs read-only git commands only (`status`, `diff`, `log`, `show`); the project owner stages, commits and pushes. The agent proposes commit messages instead.
- **Asking first:** the agent asks before every install, test, type-check or build run.
- **Env files:** the agent may read and edit `.env.example` only. It never reads or touches `.env` or any other env file.
- **Dependencies:** add none unless the phase says so. If one is unavoidable, list it in the report with the reason.
- **End every phase with a report** containing: files created or changed; commands to reproduce the demo; test results (unit, route, integration); and which checks used test doubles versus live auth-cheche.

---

## Phase 0 — Local setup

**Goal:** a generated Events API that passes the starter's full check suite against local PostgreSQL.

**Status: done on 24 November 2026.** Verified on the developer's machine:

- `TEST_DATABASE=1 npm test`: 50 of 50 passed, none skipped (the integration tests ran on `events_test`).
- `npm run db:migrate`: all 8 migrations applied to `events_dev`. `npm run db:migrate:status`: nothing pending.
- `npm run dev`: the API starts and listens on port 5010.
- After moving into the repository: `npm run check` passes (47 passed, 3 database tests skipped), and the project was pushed.
- Not reported: the `/health/ready` and `/v1/docs` checks.
- Known issue, not fixed yet: `npm run db:migrate:status` fails with "Validation error" on a database that has never been migrated. Run `npm run db:migrate` first.

### Prerequisites (on the developer's machine)

Node 24 and npm, Python 3, Homebrew PostgreSQL 17 listening on `127.0.0.1:5432`, and the skill at `/Users/joedee/typescript-backend-blueprint/skill/ts-backend-blueprint`.

### Steps

1. **Generate the project** (agent). Done.

   ```bash
   python3 /Users/joedee/typescript-backend-blueprint/skill/ts-backend-blueprint/scripts/init_project.py \
     /Users/joedee/cheche-projects/Event_management/events-api \
     --slug events --title "Events API" --table-prefix ""
   ```

   The script printed no "possible leftovers" warning. No `git init`.

2. **Remove the Docker/CI items the starter ships** (agent). Done: `Dockerfile`, `.dockerignore`, `.github/`, `.devcontainer/`. `.gitignore` stays, because it keeps `.env` out of the real repository.

3. **Move this plan into the project** at `docs/plan/implementation-plan.md` (agent). Done.

4. **Install packages:** `npm ci` in the project folder. Done.

5. **Run the check suite** (agent): `npm run check` (typecheck, lint, unit + route + contract tests, OpenAPI snapshot). No database, `.env` or network involved; the database tests are skipped. Done.

6. **Create the database login and databases** (project owner). In `psql -d postgres` as the Homebrew superuser. Run the check queries first; each must return 0 rows. `CREATE DATABASE` cannot run inside a transaction, so these take effect immediately.

   ```sql
   -- check first: both must return 0 rows
   SELECT rolname FROM pg_roles WHERE rolname = 'events';
   SELECT datname FROM pg_database WHERE datname IN ('events_dev', 'events_test');

   CREATE ROLE events LOGIN PASSWORD 'events';
   CREATE DATABASE events_dev OWNER events;
   CREATE DATABASE events_test OWNER events;

   -- verify: two rows, owner = events
   SELECT datname, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname LIKE 'events\_%';
   ```

   `events` / `events` is a local-only development login. It matches the defaults in `tests/setup-env.ts`, so integration tests need no extra configuration. It gets no superuser or create-database rights; owning its databases is enough for migrations.

7. **Create `.env`** (project owner): `cp .env.example .env`, then set:

   ```ini
   NODE_ENV=development
   PORT=5010
   LOG_LEVEL=debug
   TRUST_PROXY_HOPS=0
   JSON_BODY_LIMIT=1mb
   CORS_ALLOWED_ORIGINS=http://localhost:3000
   API_DOCS_ENABLED=true

   POSTGRES_HOST=127.0.0.1
   POSTGRES_PORT=5432
   POSTGRES_DATABASE=events_dev
   POSTGRES_USER=events
   POSTGRES_PASSWORD=events
   POSTGRES_SSL=disable
   POSTGRES_POOL_MAX=10

   # Lifetime of this API's staff access tokens, in seconds.
   APP_TOKEN_TTL_SECONDS=900

   # auth-cheche base URL WITHOUT the trailing /v1 (the client adds /v1/... itself).
   # Placeholder until the real URL is provided:
   CENTRAL_AUTH_API=http://localhost:5003
   # auth-cheche's shared secret (same name there). Also signs this API's staff tokens (one secret,
   # like bookings_api). Placeholder until provided (must be 32+ chars):
   APP_AUTH_TOKEN=placeholder-central-auth-secret-0000000000
   # The Events product's service_id in auth-cheche. Placeholder until provided:
   CENTRAL_AUTH_SERVICE_ID=00000000-0000-4000-8000-000000000000
   CENTRAL_AUTH_TIMEOUT_MS=10000

   AUTH_REFRESH_COOKIE_SAME_SITE=lax
   # auth-cheche refresh tokens live 7 days
   AUTH_REFRESH_TTL_SECONDS=604800
   AUTH_REFRESH_TRUSTED_ORIGINS=http://localhost:3000
   ```

   `PORT=5010` avoids the ports auth-cheche uses locally (5000 and 5003). There is no separate token secret: `APP_AUTH_TOKEN` also signs this API's staff tokens (see "Known risk / later" in `docs/authentication.md`). The real value is never pasted into chat.

8. **Database-backed checks** (project owner), in the project folder:
   1. `env | grep POSTGRES` prints **nothing** (shell values override the test defaults and could point the tests at another database).
   2. `TEST_DATABASE=1 npm test`: all tests pass, none skipped. Uses `events_test` and migrates it up and back down to zero.
   3. `npm run db:migrate`: 8 migrations applied to `events_dev`.
   4. `npm run db:migrate:status`: `"pending": []`.
   5. `npm run dev`, then `curl -i http://localhost:5010/health/ready` returns `200 {"status":"ready"}`, and `http://localhost:5010/v1/docs` shows the API docs.

### Done when

- `npm run check` passes.
- `TEST_DATABASE=1 npm test` passes all tests, including the integration tests.
- `GET http://localhost:5010/health/ready` returns 200, and `/v1/docs` shows the API docs.
- `npm run db:migrate:status` on `events_dev` shows no pending migrations.

---

## Phase 1 — Authentication against auth-cheche

**Goal:** staff log in through auth-cheche; `/v1/auth/staff/me` works; refresh and logout behave as the starter defines.

**Status (24 November 2026): built and tested with stand-ins; live check pending.**

- **Built:**
  - staff sign-in with mobile **or** email + password through auth-cheche, sending our `service_id`;
  - one fixed refusal message, with auth-cheche's reason in the server log;
  - 429 handling (`central_auth_rate_limited`);
  - startup refuses a `CENTRAL_AUTH_API` ending in `/v1`;
  - `pin` hidden in logs.
- **Checks:**
  - `npm run check` steps pass: typecheck, lint, OpenAPI snapshot, and 70 tests (67 passed, 3 database tests skipped).
  - `TEST_DATABASE=1 npm test`: 66 of 66 passed before email sign-in was added; not yet re-run after it.
- **Live check (step 8): pending the auth-cheche values.** It should answer:
  - what the server log shows for a wrong password and for an unknown mobile;
  - whether `platform: "web"` is accepted;
  - whether logout returns `revoked: true`;
  - whether refresh rotates the refresh cookie (test with `AUTH_CENTRAL_SESSION_TTL_SECONDS=0`);
  - whether email sign-in works for an account with an email.

  Also ask the auth-cheche team whether our server is exempt from their 5-requests-per-second-per-IP limit.

The starter's auth flow (Central Auth login → local staff token → HttpOnly refresh cookie → `/me`) stays as it is. What changes is the Central Auth client and the login contract, because the current auth-cheche contract differs from what the starter was written against.

### Already done before Phase 1 (bookings_api updates)

Built and tested with test doubles (see `docs/authentication.md` and `docs/rbac-application-flow.md`):

1. Only the signed-in assignment counts for permissions; other roles need a switch (`POST /v1/auth/staff/switch-assignment`).
2. Logout revokes the Central Auth session (`POST /v1/auth/logout` `{ refresh_token }`), best effort; `data.revoked` says whether Central confirmed.
3. A central-session confirmation cookie (`events_staff_central_session`) lets staff refresh skip Central Auth for up to `AUTH_CENTRAL_SESSION_TTL_SECONDS` (default 6 hours).
4. `AUTH_REFRESH_COOKIE_PATH_PREFIX` for running behind a proxy path such as `/api`.

Planned Central Auth integrations (creating staff accounts, reading users, editing details, forgot password) and the role-assignment rules are documented there as *not built yet*.

### auth-cheche facts to implement against (auth-cheche's live spec, `https://auth.cheche.et/api/v1/swagger/doc.json`)

Decisions (24 November 2026): PIN sign-in is the legacy setup. Staff log in with **mobile + password** or
**email + password** (exactly one of mobile or email per request).

| Topic | auth-cheche contract |
|---|---|
| Base URL | Production `https://auth.cheche.et/api`; every path starts with `/v1`. (The guide's `https://auth.cheche.et/v1` is out of date.) |
| Sign-in | `POST /v1/users/signin/password?service_id=<uuid>` with body `{ mobile, password, device_id?, device_name?, platform? }`. `service_id` makes auth-cheche refuse accounts not registered for the service. |
| Email sign-in | `POST /v1/users/signin/email?service_id=<uuid>` with body `{ email, password, device_id?, device_name?, platform? }`; same replies as mobile sign-in. Only for accounts that have an email in auth-cheche. |
| Sign-in replies | 200 not wrapped: `{ message, access_token, refresh_token, … }`. 400 invalid input · 401 invalid credentials · 403 not verified or not registered for the service · 404 user not found · 429 account locked after too many failed attempts. A sign-in attempt on an unverified account resends an OTP. |
| Refresh | `POST /v1/auth/refresh` with body `{ refresh_token }`; returns a new access **and** refresh token (rotation) |
| Logout | `POST /v1/auth/logout` with optional body `{ refresh_token }`; no Bearer token required |
| Token | HS256, signed with the shared secret (`APP_AUTH_TOKEN` on auth-cheche's side) |
| Claims | `user_id`, `sub`, `firstname`, `middlename`, `lastname`, `mobile`, `service_ids`, `token_type` (`"access"` or `"refresh"`), `auth_role`, `session_id`, `iss = "auth_api"`, `exp`, `iat` |
| Lifetimes | Access 3 days, refresh 7 days |
| Mobile format | `+251XXXXXXXXX` |
| Errors | `{ "error": "…" }`; OTP endpoints `{ "response": "…" }`; 429 `{ "message": "Too many requests" }` |
| Rate limit | 5 requests per second per IP (all of this API's calls share the server's IP) |

### Steps

1. **Inspect first.** Read `src/clients/central-auth.client.ts`, `src/validators/auth.ts`, `src/services/auth.service.ts`, `src/services/auth-token.service.ts`, `src/routes/v1/auth.ts`, the auth tests and fixtures. Report anything that contradicts the table above before changing code.

2. **Central Auth client** (`src/clients/central-auth.client.ts`):
   - `passwordLogin(input)` keeps calling `POST /v1/users/signin/password`, now with the query parameter `service_id = CENTRAL_AUTH_SERVICE_ID` and the body `{ mobile, password, device_id?, device_name?, platform? }`. Keep `credentialsFlow: true` and `requireRefresh: true`.
   - `refreshAccessToken` keeps calling `POST /v1/auth/refresh` with `{ refresh_token }`.
   - Make the upstream error-message reader accept `error`, `response` and `message` fields.
   - Map an upstream **429** to a new error `CentralAuthRateLimitedError` (HTTP 429, code `central_auth_rate_limited`), added to `src/errors/app-errors.ts` following the existing class shape.
   - Login and refresh refusals (400, 401, 403, 404) all become `invalid_credentials` with one fixed message, so the screen never learns whether the account exists; the real reason goes to the server log.

3. **Login contract** (`src/validators/auth.ts`): `staffLoginRequest` body becomes:
   - `mobile`: the existing mobile schema, normalised to `+251XXXXXXXXX`
   - `password`: non-empty string, max 128
   - `device_id`, `device_name`: optional strings, max 128
   - `platform`: optional enum `ios | android | web`

   No `pin`: a body that still sends one is rejected (400). `src/services/auth.service.ts` passes these through to `passwordLogin`. Nothing else in the login logic changes: the user still needs an active staff assignment, and the starter's assignment selection rules stay.

4. **Token verification** (`src/services/auth-token.service.ts`): the starter's Central Auth claim schema already accepts the claims above (loose object, `token_type = "access"`, issuer `auth_api`). Confirm with a test that a token shaped exactly like the auth-cheche example verifies, and that a token with `token_type = "refresh"` is rejected. Do **not** add a `service_ids` check; the staff assignment is the gate.

5. **Secret length:** if the real auth-cheche secret turns out shorter than 32 characters, lower the minimum for `APP_AUTH_TOKEN` in `src/config/env.ts`. Because it is the only secret, this also shortens the key that signs this API's staff tokens: state that in the Phase 1 report.

6. **Documentation:** update `.env.example` comments (base URL without `/v1`; 7-day refresh) and `docs/authentication.md`. Regenerate the OpenAPI snapshot with `npm run openapi`.

7. **Tests** (test double for auth-cheche: `mock.method(centralAuthClient, …)`; Central Auth-style tokens signed in fixtures with `APP_AUTH_TOKEN`, using the claim shape above):
   - Login success: 200; body has `accessToken` and **no** refresh token; `Set-Cookie: events_staff_refresh` is `HttpOnly`, `Path=/v1/auth/staff`.
   - Login with valid credentials but no active assignment: 403 `staff_assignment_not_found`.
   - Login with wrong credentials (upstream 401): 401 `invalid_credentials`.
   - Upstream 429: 429 `central_auth_rate_limited`. Upstream down or timing out: 503 `central_auth_unavailable`.
   - Unknown body field (including a legacy `pin`): 400 `validation_error`, and auth-cheche is not called.
   - Refresh with cookie: 200 and a new access token. Without cookie: 401 `refresh_token_missing`. From an untrusted `Origin`: 403 `refresh_origin_not_allowed`.
   - Logout: 200 and both cookies are cleared; `data.revoked` is `true` when Central Auth confirms the revoke, `false` when it fails or no cookie was sent (already built and tested, see above).
   - `GET /v1/auth/staff/me` with a valid staff token: 200 with user, assignment, permissions and navigation. With an expired token: 401 `expired_token`. Without a token: 401 `authentication_required`.

8. **Live check** (only when auth-cheche access is available; the project owner runs the commands that load `.env`):
   1. Get the test user's Central Auth `user_id`: call auth-cheche sign-in directly and read `user_id` from the access token's payload (the middle segment of the JWT, base64-decoded).
   2. Give that user a platform assignment: `npm run bootstrap:super-admin -- --user-id <id>` (preview), then the same with `--confirm`.
   3. Exercise the API:

      ```bash
      curl -i -c cookies.txt -H 'Content-Type: application/json' -H 'Origin: http://localhost:3000' \
        -d '{"mobile":"09XXXXXXXX","password":"XXXX","platform":"web"}' \
        http://localhost:5010/v1/auth/staff/login
      curl -i -H "Authorization: Bearer <accessToken>" http://localhost:5010/v1/auth/staff/me
      curl -i -b cookies.txt -c cookies.txt -X POST -H 'Origin: http://localhost:3000' \
        http://localhost:5010/v1/auth/staff/refresh
      curl -i -b cookies.txt -c cookies.txt -X POST -H 'Origin: http://localhost:3000' \
        http://localhost:5010/v1/auth/staff/logout
      ```

### Done when

- All Phase 1 tests pass, `npm run check` passes, and `TEST_DATABASE=1 npm test` passes.
- The report states whether the live check ran, or is pending credentials.

---

## Phase 2 — Authorization and tenant isolation

**Goal:** prove with real database data that an owner can act in their own organization, a viewer's write is denied, office-scoped staff are limited to their office, and nobody reaches another organization or platform administration.

**Status (24 November 2026): done, verified on the real database.**

- **Built:** default `OWNER` and `VIEWER` roles; the provisioning service and scripts (`provision:organizer`, `assign:staff`, `dev:staff-token`); and organizations without branches (`has_branches`, hidden `MAIN` branch, migration `20261124000000-add-organization-has-branches`).
- **Checks:**
  - `TEST_DATABASE=1 npm test`: 104 of 104 passed, none skipped. That includes all 21 rows of the authorization matrix on `events_test`.
  - The migration was applied to `events_dev`.
- **Not run by hand yet:** the demo scripts on `events_dev`. Their logic runs in the tests; their command-line handling has only been type-checked and linted.

The starter already contains the RBAC engine (modules, roles, role grants, assignments, overrides, Super Admin, explicit scope, `/me` permissions and menu) and protected routes for organizations and branches. This phase adds the provisioning the pilot needs and proves the rules end to end. **No new HTTP endpoints** are added in this phase.

### Steps

1. **Default tenant roles** as a constant in `src/utils/default-roles.ts`, using existing module codes only:

   | Role code | Name | Grants |
   |---|---|---|
   | `OWNER` | Owner | `ORGANIZATIONS`: view, update · `BRANCHES`: view, create, update · `ROLES`: view · `USER_ROLES`: view |
   | `VIEWER` | Viewer | `ORGANIZATIONS`: view · `BRANCHES`: view |

   Later phases add their modules (`CUSTOMERS`, `EVENTS`, `REGISTRATIONS`) and extend these grants through migrations.

2. **Provisioning service** `src/services/organization-provisioning.service.ts`, an aggregate service running in **one** `runTransaction`:
   - `provisionOrganizer({ name, slug?, ownerUserId }, actorId)`: creates the organization and its default `MAIN` branch (reuse the existing organization creation logic), creates the `OWNER` and `VIEWER` roles for that organization with their grants, and creates the owner's organization-wide assignment.
   - `assignStaff({ organizationId, userId, roleCode, branchCode? }, actorId)`: creates an assignment, scoped to the branch when `branchCode` is given. Friendly errors for an unknown role or branch and a user already assigned in another organization, counting inactive assignments like the trigger does (the database trigger stays as the backstop). An identical active assignment is left unchanged; an identical inactive one is reactivated (decided 24 November 2026).
   - Add the repository methods these need (role create and find by organization and code, role grant bulk create, branch find by organization and code, assignment create), following the `branch` repository conventions.

3. **Scripts** following the `bootstrap-super-admin.ts` template (preview by default, `--confirm` to write, JSON output):
   - `src/scripts/provision-organizer.ts --name "Selam Events" --owner-user-id <uuid> [--slug selam-events] [--confirm]`
   - `src/scripts/assign-staff.ts --organization-slug selam-events --user-id <uuid> --role-code VIEWER [--branch-code ADDIS] [--confirm]`
   - `src/scripts/dev-staff-token.ts --user-id <uuid>`: **development only**. Refuses to run when `NODE_ENV=production`. Signs a staff token with `APP_AUTH_TOKEN` for that user's active assignment, so the demo below works before auth-cheche access arrives.
   - Add the matching `npm` scripts in `package.json`.

4. **Integration test** `tests/integration/authorization.test.ts`. Real PostgreSQL (`events_test`), real app via `createApp()` + `withServer`, real signed staff tokens, **no** stubbed permission engine. Fixture, built through the provisioning service:
   - **Selam Events:** branches `MAIN` and `ADDIS`. Users: `SELAM_OWNER` (OWNER), `SELAM_VIEWER` (VIEWER), `SELAM_ADDIS` (VIEWER, scoped to `ADDIS`).
   - **Horn Health Alliance:** branch `MAIN`. User: `HORN_OWNER` (OWNER).
   - `SUPER` (platform Super Admin, via the bootstrap service) and `NO_ROLE` (no assignment).

   | # | Caller | Request | Expected |
   |---|---|---|---|
   | 1 | SELAM_OWNER | `GET /v1/organizations/{selam}/branches` | 200, exactly Selam's 2 branches |
   | 2 | SELAM_OWNER | `POST /v1/organizations/{selam}/branches` | 201 |
   | 3 | SELAM_VIEWER | `GET /v1/organizations/{selam}/branches` | 200 |
   | 4 | SELAM_VIEWER | `POST /v1/organizations/{selam}/branches` | 403 `permission_denied`; no row created |
   | 5 | SELAM_VIEWER | `PATCH …/branches/{selamMain}` | 403 |
   | 6 | SELAM_ADDIS | `GET …/branches/{selamAddis}` | 200 |
   | 7 | SELAM_ADDIS | `GET …/branches/{selamMain}` | 403 |
   | 8 | SELAM_ADDIS | `GET /v1/organizations/{selam}/branches` (organization-wide) | 403 |
   | 9 | SELAM_OWNER | `GET /v1/organizations/{horn}/branches` | 403 |
   | 10 | SELAM_OWNER | `GET /v1/organizations/{horn}` | 403 |
   | 11 | SELAM_OWNER | `POST /v1/organizations` (platform) | 403 |
   | 12 | SUPER | `POST /v1/organizations` | 201 |
   | 13 | SUPER | `GET /v1/organizations/{horn}/branches` | 200 |
   | 14 | SELAM_VIEWER | `GET /v1/auth/staff/me` | `permissions.BRANCHES` = view only; the menu shows Administration › Organizations and Branches (VIEWER has `ORGANIZATIONS` view) and no Access Control |
   | 15 | SELAM_OWNER | `GET /v1/auth/staff/me` | `BRANCHES` view/create/update; Access Control visible |
   | 16 | SELAM_VIEWER + override `BRANCHES.can_create = true` | `POST …/branches` | 201 (override allows) |
   | 17 | SELAM_OWNER + override `BRANCHES.can_create = false` | `POST …/branches` | 403 (deny wins) |
   | 18 | — | `assignStaff` for HORN_OWNER into Selam | rejected (one person, one organization) |
   | 19 | HORN_OWNER (Horn has no branches) | `GET /v1/auth/staff/me` | `organization.has_branches = false`; Administration shows Organizations only |
   | 20 | — | `assignStaff` with a branch code in Horn | rejected (`invalid_branch_state`) |
   | 21 | HORN_OWNER | `POST …/branches`, then `GET /v1/auth/staff/me` | 201; then `has_branches = true` and Branches visible |

   **Organizations without branches** (decided 24 November 2026): every organization keeps a default `MAIN` branch, created with it. `organization.has_branches` (default `false`, new migration `20261124000000-add-organization-has-branches`) decides whether its staff see branches. Adding a branch turns it on. Selam is provisioned with `--has-branches`; Horn without.

   Also unit-test the provisioning service (transaction propagation, role and grant creation, errors) with the `transactionManager` and repository mocks, like `branch.service.test.ts`.

   Test files run one at a time (`--test-concurrency=1` in `npm test`), because this file and `tests/integration/database.test.ts` both migrate `events_test` down and up.

5. **Docs:** `docs/rbac-application-flow.md` gets the default roles, the scripts and organizations without branches; `docs/database-foundation.md` gets the `has_branches` column (no new tables).

### Demo (on `events_dev`)

```bash
npm run provision:organizer -- --name "Selam Events" --owner-user-id <owner-uuid> --confirm
npm run assign:staff -- --organization-slug selam-events --user-id <viewer-uuid> --role-code VIEWER --confirm
npm run dev:staff-token -- --user-id <owner-uuid>     # or log in through auth-cheche if live
curl -H "Authorization: Bearer <owner token>"  http://localhost:5010/v1/organizations/<selam-id>/branches   # 200
curl -X POST -H "Authorization: Bearer <viewer token>" -H 'Content-Type: application/json' \
  -d '{"code":"ADDIS","name":"Addis Office"}' http://localhost:5010/v1/organizations/<selam-id>/branches  # 403
```

### Done when

- All 21 rows of the matrix pass in `TEST_DATABASE=1 npm test`, and `npm run check` passes.
- The demo reproduces an allowed and a denied request from the command line.
- **This completes the first milestone:** a staff member signs in, sees their permissions in `/me`, can act in their own organization, and is denied everywhere else.

### Phase 2b — Roles and Staff Assignments over HTTP (25 November 2026)

**Why:** Phase 2 managed staff through scripts only. events-web showed 6 of the 11 menu items, because the *Access Control* items had no endpoints, while owners were already granted view on Roles and Staff Assignments.

**Decisions (25 November 2026):**
- **Build:** Staff Assignments (list, look up, add, change role or branch, activate or deactivate) and Roles (read only).
- **Leave hidden:** Modules, Role Templates and Permission Overrides.
- **Adding staff = look up only:** the person needs a Cheche account, found by mobile. This API never creates accounts or handles passwords.
- **Owners** gain create and update on `USER_ROLES`.
- **The last active Owner** can't be removed.
- **Screens:** your colleague's AI builds them from the spec in `docs/frontend-integration.md`, after this is pushed.

Details are in `docs/rbac-application-flow.md` ("Managing staff over HTTP").

**Status: done.** Migration `20261127000000-grant-staff-management-to-owners` was applied to `events_dev`. `TEST_DATABASE=1 npm test` passed 256 of 256 on the real database, none skipped. That includes matrix rows 51–55, with auth-cheche stubbed: roles, lookup and assign, refusals, the last-Owner guard, access limits, and names being best effort. `npm run check` passed beforehand, with the OpenAPI snapshot up to date. Not verified yet: the service token against the real auth-cheche (check it by hand with `staff-lookup`).

**Fix found by the frontend (25 November 2026):** `POST /v1/organizations` created no roles, so organizations made in the app had empty Roles and Staff pages. It now creates the default `OWNER` and `VIEWER` in the same transaction, the same code as `provision:organizer`. Migration `20261127000100-backfill-default-roles` repairs existing bare organizations. The first Owner is added by the Super Admin through Staff Assignments. Matrix row 56 covers it. **Status: done.** The migration was applied to `events_dev`. `TEST_DATABASE=1 npm test` passed 259 of 259 on the real database, none skipped, including row 56. `npm run check` passed beforehand.

### Phase 2c — Custom roles and organization management (25 November 2026)

**Why:** after Phase 2b, roles could only be read: every organization had just Owner and Viewer. A review of all endpoints found three more gaps: an organization's name and description couldn't be edited, an organization couldn't be switched off or on, and the first Owner couldn't be added when creating the organization.

**Decisions (25 November 2026):**
- **What a tenant role may hold:** the code constant `TENANT_GRANTABLE` (`src/utils/rbac.ts`): view, create and update on the tenant modules, only view and update on `ORGANIZATIONS`, nothing on platform modules. This settles the open decision in `docs/rbac-application-flow.md`.
- **No escalation:** nobody grants an action they don't hold in their signed-in assignment (`403 grant_exceeds_own_access`).
- **`OWNER` is locked; `VIEWER` is editable.** Codes are fixed after creation.
- **Switching off a role staff still hold is refused** (`409 role_in_use`) until they're reassigned.
- **Owners** gain create and update on `ROLES` (migration `20261128000000-grant-role-management-to-owners`; `default-roles.ts` for new organizations).
- **Organizations:** name and description become editable (the slug never changes); switching off and on is Super Admin only; `owner_mobile` adds the first Owner when creating one.
- **Who builds what:** the API here; the screens by Antigravity from `docs/ui-brief-phase-2c.md`.

Details are in `docs/rbac-application-flow.md` ("Custom roles and organization switching").

**Status: done (25 November 2026).**
- **Database:** migration `20261128000000-grant-role-management-to-owners` was applied to `events_dev`.
- **Tests:** `TEST_DATABASE=1 npm test` passed on the real database, including matrix rows 57–62. The first run found that an impossible grant was refused with 403 instead of 400, because escalation was checked first. The grants are now checked before escalation. `npm run check` passed: typecheck, lint, the tests on fakes, and the OpenAPI snapshot.
- **Screens:** Antigravity built them in events-web from `docs/ui-brief-phase-2c.md`. A review found one bug: saving a role in an organization without branches dropped its hidden Branches grant. It's fixed. events-web typecheck and lint pass. Both repositories are committed and pushed.
- **Checked by hand:** the project owner checked the screens and the flows in the app, and they work.

---

## Phases 3–5 — outline

Each of these phases gets its detailed version (steps, tables, endpoints, test matrix) in this file **after the previous phase is verified**. Scope is the 23 November MVP 1 specification.

### Phase 3 — Events

**Source of truth:** `docs/event-management-mvp1-final.md` (sections 3, 4, 5, 7). Feature doc: `docs/events.md`.
**Steps:**
- **3a** clients (`customer_account`) and venues, plus the `EVENTS` and `CUSTOMERS` modules and menu;
- **3b** `event` and `ticket_type`, plus tenant-scoped `file` metadata and a nullable `cover_file_id`;
- **3c** the public catalog and event detail;
- **3d** cover upload and the storage provider. 3d stays on the MVP 1 list, so covers are ready for launch.

**Decisions (24 November 2026):**
- `customer_account` is the commissioning client, never an attendee.
- One name and description per event; map links, translated fields and a category table come later.
- An organization-wide event uses `branch_id = NULL`, even when a default `MAIN` branch exists. Organizations without branches therefore never involve the hidden branch.

**3a status: done.** The 4 migrations were applied to `events_dev`; `TEST_DATABASE=1 npm test` passed 116 of 116, none skipped; committed separately.

**3b decisions (25 November 2026), detailed in `docs/events.md`:**
- the organization gets editable defaults `ET` / `Africa/Addis_Ababa` / `ETB`, and an event copies the timezone once;
- the slug is generated with `-2`, `-3` on a clash and frozen after the first publication;
- publishing needs a name, slug, timezone, `starts_at < ends_at` and an active ticket type, while capacity, venue and cover stay optional;
- `DRAFT → PUBLISHED | CANCELLED` and `PUBLISHED → CLOSED | CANCELLED`, with CLOSED and CANCELLED terminal;
- stopping sign-ups means setting `registration_closes_at` while the event stays PUBLISHED;
- a ticket limit fits within the event limit;
- General Admission is created in the same transaction, with no own limit;
- events start as DRAFT and UNLISTED, and category is free text;
- `branch_id = NULL` means organization-wide, any active branch of the organization may be chosen, and branch-only staff get 403.

**3b status: done.** The 4 migrations (`20261125000100` to `…103`) were applied to `events_dev`; `TEST_DATABASE=1 npm test` passed 145 of 145 on the real database, none skipped (including matrix rows 26–31); committed separately. Four product rules were accepted on 25 November 2026 (see `docs/events.md`).

**3c decisions (25 November 2026):**
- **Catalog:** upcoming and live `PUBLISHED` + `PUBLIC` events of active organizations (`now < ends_at`), by `starts_at` then id. Filters: exact, case-insensitive `category`, and `organization` (an organization slug).
- **Direct links:** any event published at least once (`published_at` set) stays reachable by both slugs, including UNLISTED, ended, CLOSED or CANCELLED-after-publication events. Drafts, never-published cancellations and inactive organizations get 404.
- **Visitor fields:** the commissioning client, staff, internal ids and audit fields stay private.
- **`registration_open`:** a PUBLISHED event that hasn't ended and is inside its window. The opening time is inclusive, the closing time exclusive, and an unset boundary adds no limit. Capacity joins in Phase 4.

**3c status: done.** Migration `20261125000200-add-event-published-at` was applied to `events_dev`; `TEST_DATABASE=1 npm test` passed 153 of 153 on the real database, none skipped (including matrix rows 32–37 through the public endpoints).

**3d decisions (25 November 2026), detailed in `docs/events.md`:**
- **Storage:** local disk in `FILES_DIR` (default `/assets/uploads`, a mounted volume in production), covers under `events/covers/<uuid>.<ext>`, behind a `save`/`delete`/`url` interface so a bucket can come later. No S3 SDK.
- **Upload:** `multipart/form-data` through the API (multer, memory storage), one file in `file` and nothing else; JPEG, PNG or WebP by contents, up to 5 MB, no resizing.
- **Serving:** `express.static` at `/assets/uploads` with CORP `cross-origin`; `cover: { url }` on staff and public replies.
- **Records:** one `file` row per upload (`EVENT_COVER`, the event as entity, `uploaded_by`); old files are cleaned up later.

**3d status: done.** Migration `20261125000300-add-file-entity-uploader-provider` was applied to `events_dev`; `TEST_DATABASE=1 npm test` passed 174 of 174 on the real database, none skipped (including matrix rows 38–40 through the cover endpoints and the static `/assets/uploads` folder). `npm run check` passed beforehand, with the OpenAPI snapshot up to date.

**Sign-in change (25 November 2026):** staff sign-in no longer sends `?service_id=` to auth-cheche, like bookings_api. With it, auth-cheche answered `403 User is not registered for this service` for accounts not registered to that service. Access is decided by this API's own `user_role` rows. Verified by signing in from events-web.

- **Tables:** `customer_account`, `venue`, `event`, `ticket_type`, plus `file` for cover images.
- **Permission modules** (seeded by migration, added to `OWNER`, read-only for `VIEWER`): `CUSTOMERS`, `EVENTS`.
- **Event states:** `DRAFT`, `PUBLISHED`, `CLOSED`, `CANCELLED`. *Live* is derived from dates. A new event gets **General Admission** automatically.
- **Public read endpoints:** catalog (published + `PUBLIC`), and event detail by organization slug + event slug (published, `PUBLIC` or `UNLISTED`).
- **Proof:** Selam publishes an organization-wide forum for ABC Bank; it appears in the catalog; an unlisted workshop opens by link only; a draft stays private; PostgreSQL rejects a venue from another organization.

### Phase 4 — Registration

- **Tables:** `person`, `registration`, the message outbox, and a durable retry key for public submissions.
- **Module:** `REGISTRATIONS`.
- **One registration service** behind staff entry and public entry: lock the event, then the ticket type; check status, registration window and both capacities; store `CONFIRMED`, source, actor and a random code; record the privacy notice shown; queue the confirmation in the same transaction; an outbox worker sends it.
- **Proof:** two guests race for the last seat and only one wins; a retried submission returns the original registration with one confirmation in total; cancelling frees the seat.

**Split (25 November 2026), built and verified one at a time like 3a–3d** (feature doc: `docs/registrations.md`):
- **4a:** guest profiles (`person`), staff registration and the guest list. Adds `registration`, `message_outbox` and the `REGISTRATIONS` module ("Guests"). The one registration service locks the event, then the ticket type, then the registration. Confirmations are queued in the same transaction.
- **4b:** public registration without login. The `submission_key` table makes an `Idempotency-Key` retry return the original result. Privacy-notice evidence is recorded, and the public POST gets its own rate limit.
- **4c:** sending. An SMS sender interface (`log` and AfroMessage; the token only from `PLATFORM_SMS_AFROMESSAGE_TOKEN`), the outbox worker, the Ethiopian calendar, the English message text (Ethiopian date and clock first, then Gregorian 12-hour), and abuse caps.

**Phase 4 decisions (25 November 2026):**
- Staff follow the public form's rules: published, not ended, inside the window, an active ticket type and room.
- One registration per guest per event: a repeat is harmless, another ticket type gets 409, and a cancelled guest is reactivated on the same row and code.
- Public guests always get a new, unlinked profile; retries are recognised only by `Idempotency-Key`.
- Codes are 8 characters with no look-alikes, unique across the platform.
- Only `CONFIRMED` registrations count, and a capacity can't drop below them.
- Cancelling is staff only, for PUBLISHED or CLOSED events, with no SMS.
- `VIEWER` reads the guest list.
- The privacy notice version is a platform constant, and staff entries record no consent.
- SMS in English through AfroMessage, with `log` mode by default.

**4a status: done.** Migrations `20261126000000` to `…004` (`person`, `registration`, `message_outbox`, the `REGISTRATIONS` module and its grants) were applied to `events_dev`. `TEST_DATABASE=1 npm test` passed 202 of 202 on the real database, none skipped. That includes matrix rows 41–46: row 42 has five guests racing for the last place, and exactly one wins. `npm run check` passed beforehand, with the OpenAPI snapshot up to date.

**4b status: done.** Migration `20261126000100-create-submission-key` was applied to `events_dev`. `TEST_DATABASE=1 npm test` passed 221 of 221 on the real database, none skipped. That includes matrix rows 47–49: a retried submission, even two copies sent at the same moment, returns the original registration with one confirmation in total. `npm run check` passed beforehand, with the OpenAPI snapshot up to date. Refinements to the approved plan:
- `Idempotency-Key` is checked by the request contract, so a missing key gives 400 `validation_error` at `headers.idempotency-key`;
- only successful registrations store a key;
- the privacy notice version starts as `2026-11-26`.

**4c status: done.** There's no migration. `TEST_DATABASE=1 npm test` passed 237 of 237 on the real database, none skipped. That includes matrix row 50: the outbox worker, using the log sender, sends every due confirmation exactly once and leaves leased messages alone, and staff see `SENT`. `npm run check` passed beforehand, with the OpenAPI snapshot unchanged. Settings: `SMS_DELIVERY` (default `log`), `PLATFORM_SMS_AFROMESSAGE_TOKEN`, `PLATFORM_SMS_AFROMESSAGE_FROM_ID` and `PLATFORM_SMS_SENDER` (required for `afromessage`), plus the worker settings.

**Phase 4 status: done (25 November 2026).** Staff entry, public registration with retry keys, and confirmation SMS work through one registration service. The outline's three proofs pass on PostgreSQL: the race for the last place (row 42), the retried submission (row 47), and cancelling to free a place (row 43). Not verified yet: a real AfroMessage send, which needs your token. Do that by hand with your own number.

### Phase 5 — Pilot walkthrough

Connect the staff and public screens to the API and run the full flow against PostgreSQL: a guest discovers an event, registers, receives a code, and appears once on the staff guest list.

- The staff app never sees the refresh token: it lives only in the HttpOnly cookie. Do not copy the auth-cheche guide's frontend example, which keeps tokens in `localStorage`.
