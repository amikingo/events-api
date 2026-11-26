# Frontend integration guide (staff app)

How a browser app signs staff in and calls the Events API. Everything here is checked against the code. The
full contract (every field, every status) is in [`docs/api/openapi-v1.json`](api/openapi-v1.json), or at
`http://localhost:5010/v1/docs` while the API runs.

**Available now:** staff sign-in, session, role switching, organizations, and branches.
**Not yet:** events, registrations and public pages (Phases 3–4). See the end of this page.

---

## 1. Run the API locally

You need Node 24 and a local PostgreSQL (15 or newer).

1. `npm ci`
2. Create the database login and databases. The SQL is in [`docs/plan/implementation-plan.md`](plan/implementation-plan.md),
   Phase 0 step 6.
3. `cp .env.example .env`, then set the database values and the settings below.
4. `npm run db:migrate`, then `npm run dev`. The API listens on `http://localhost:5010`.
   `GET /health/ready` returns `{"status":"ready"}` when it can reach the database.

**Settings that matter for the frontend (`.env`):**

| Setting | Set it to |
|---|---|
| `CORS_ALLOWED_ORIGINS` | Your dev origin exactly (scheme, host, port, no trailing slash). Comma-separated for several, e.g. `http://localhost:3000,http://localhost:5173`. |
| `AUTH_REFRESH_TRUSTED_ORIGINS` | The same origin(s). Refresh and logout refuse any other site (`403 refresh_origin_not_allowed`). |
| `CENTRAL_AUTH_API`, `APP_AUTH_TOKEN`, `CENTRAL_AUTH_SERVICE_ID` | Real auth-cheche values, from the project owner. `CENTRAL_AUTH_API` has **no** `/v1` at the end. Without them, login returns `503 central_auth_unavailable`. |
| `LOG_LEVEL` | `info` or `debug`, so you can see why a request was refused. |
| `FILES_DIR` | An absolute folder for uploaded covers, e.g. `/Users/<you>/events-uploads`. On a Mac this is needed, because the default `/assets/uploads` doesn't exist there; without it, cover uploads return `503 file_storage_unavailable`. |

**Working without auth-cheche (development only).** Until the auth-cheche values arrive, you can still build the
staff screens. Create an organization and a person locally, then print a normal staff token for them:

```bash
npm run provision:organizer -- --name "Selam Events" --owner-user-id <any-uuid> --confirm
npm run dev:staff-token -- --user-id <the-same-uuid>
```

Put the printed `accessToken` in your app's memory, as if login had returned it. Every Bearer call (`/me`,
organizations, branches) then works. It lasts 15 minutes; run the command again for a new one. Login, refresh and
logout still need auth-cheche. The script refuses to run unless `NODE_ENV=development`. Treat the token like a
password.

**Your account needs a role in this API.** An auth-cheche account alone gets `403 staff_assignment_not_found`
at login. Once you know your auth-cheche `user_id` (the project owner can find it), give yourself platform
access in your local database:

```bash
npm run bootstrap:super-admin -- --user-id <your-user-id>             # preview
npm run bootstrap:super-admin -- --user-id <your-user-id> --confirm   # apply
```

---

## 2. Response shapes

```jsonc
// success
{ "success": true, "data": { ... }, "message": "Branch created" }
// list (organizations, branches)
{ "success": true, "data": [ ... ], "meta": { "count": 42, "page": 1, "pageSize": 20 } }
// error
{ "success": false, "error": { "code": "validation_error", "message": "...", "details": { ... } } }
```

- **Branch on `error.code`, never on `error.message`.** Messages may change; codes are the contract.
- Every response has an `X-Request-Id` header. Put it in bug reports so the request can be found in the logs.
- List endpoints take `?page=1&pageSize=20` (`pageSize` at most 100), and `?is_active=true|false` where offered.

---

## 3. Staff sign-in

### How the tokens work

| | Where it lives | Lifetime | You handle it? |
|---|---|---|---|
| **Access token** | In `data.accessToken`. Keep it **in memory only** (a variable or store), never in `localStorage` or `sessionStorage`. | `data.expiresIn` seconds, at most 15 minutes | Yes: send `Authorization: Bearer <accessToken>` on every API call |
| **Refresh token** | HttpOnly cookie `events_staff_refresh`, path `/v1/auth/staff` | Up to 7 days (`AUTH_REFRESH_TTL_SECONDS`) | No. JavaScript cannot read it; the browser sends it to refresh and logout |
| **Central-session cookie** | HttpOnly cookie `events_staff_central_session`, same path | Up to 6 hours | No. It lets refresh skip auth-cheche |

> The auth-cheche guide's frontend example stores tokens in `localStorage`. **Do not copy it for this API.**

Because the access token lives in memory, a page reload loses it. On app start, call **refresh**. If it
succeeds, the user is still signed in. If it fails with `refresh_token_missing`, show the login screen.

The current assignment id (`data.assignment.id`) is **not** a secret. Keep it in `localStorage`, so refresh can
send it after a reload. A person with several roles otherwise gets `409 staff_context_required`.

### Endpoints

| Call | Body | Notes |
|---|---|---|
| `POST /v1/auth/staff/login` | `{ mobile, password, … }` **or** `{ email, password, … }`, plus optional `device_name`, `device_id`, `platform` | Send exactly one of `mobile` or `email` (both or neither gets `400`). `mobile` may start with `09` or `07`, or with `251` or `+251` (spaces and dashes are ignored). Email login works only for accounts that have an email in auth-cheche. `platform` is `"web"` for the browser. Send with `credentials: "include"` so the cookies are stored. A legacy `pin` field gets `400`. |
| `POST /v1/auth/staff/refresh` | `{ assignment_id? }` | `credentials: "include"`, no Bearer header. Returns a new access token. |
| `POST /v1/auth/staff/logout` | none | `credentials: "include"`. Returns `{ revoked: true \| false }`. Clear the in-memory token whatever the answer. |
| `GET /v1/auth/staff/me` | | Bearer. User, current assignment, all assignments, `permissions`, `navigation`. |
| `POST /v1/auth/staff/switch-assignment` | `{ assignment_id }` | Bearer. Returns a new access token for that role. Fetch `/me` again afterwards. |

Login, refresh and switch all return the same `data`:

```jsonc
{
  "accessToken": "eyJ…", "tokenType": "Bearer", "expiresIn": 900,
  "user": { "id": "…", "mobile": "+2519…", "firstname": "…", "middlename": null, "lastname": "…" },
  "assignment":  { "id": "…", "organization_id": "…", "branch_id": null,
                   "role": { "id": "…", "code": "OWNER", "name": "Owner" },
                   "organization": { "id": "…", "name": "Selam Events", "has_branches": false }, "branch": null },
  "assignments": [ /* every active assignment, same shape */ ]
}
```

`/me` adds:
- `permissions`: a map from module code to `{ view, create, update, delete, import, export, notify }`, for example
  `permissions.BRANCHES.create`;
- `navigation`: a tree of `{ id, code, module_name, route_name, icon, parent_id, sno, children }`, already
  filtered and ordered.

Use both to build menus and hide buttons. **The server checks permissions on every request anyway**, so this is
for the user's convenience, not security.

**Organizations without branches.** Most organizers have no branches. When `assignment.organization.has_branches`
is `false`, **hide everything about branches**: branch pickers, branch columns, branch pages, branch filters. The
server already leaves *Branches* out of `navigation` for them: since Phase 2e a feature gate turns every *Branches*
action except `create` off (`permissions.BRANCHES` shows them `false`), and the branch routes answer 403 with
`details.reason: "feature_disabled"`. Don't call `GET …/branches` for these users. Behind the scenes the organization still has one
hidden `MAIN` branch, so the API never needs a branch from these users. If an owner adds a branch (`POST …/branches`),
branches switch on for that organization. Fetch `/me` again afterwards, and the branch screens appear.

Two more menu details:

- **Organizations** (`route_name: "/organizations"`) also appears for staff of one organization, because they may
  read their own organization. Listing organizations is platform-only, so for tenant staff
  (`assignment.organization_id` is not null) open `/organizations/{assignment.organization_id}` instead of the list.
- **Access Control** items (Roles, Staff Assignments, …) can appear for owners, but their endpoints don't exist
  yet. Show those pages as "coming soon".

### Example (framework-free TypeScript)

```ts
const API = "http://localhost:5010";
let accessToken: string | null = null;
let refreshing: Promise<void> | null = null;

function rememberSession(data: { accessToken: string; assignment: { id: string } }) {
  accessToken = data.accessToken;
  localStorage.setItem("assignmentId", data.assignment.id); // not a secret
}

/** `identifier` is either { mobile } or { email }. */
export async function login(identifier: { mobile: string } | { email: string }, password: string): Promise<void> {
  const res = await fetch(`${API}/v1/auth/staff/login`, {
    method: "POST",
    credentials: "include", // store the HttpOnly cookies
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...identifier, password, platform: "web" }),
  });
  const body = await res.json();
  if (!res.ok) throw body.error; // { code, message, details? }
  rememberSession(body.data);
}

/** One refresh at a time: parallel calls share the same request. */
export function refresh(): Promise<void> {
  refreshing ??= (async () => {
    const assignmentId = localStorage.getItem("assignmentId");
    const res = await fetch(`${API}/v1/auth/staff/refresh`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(assignmentId ? { assignment_id: assignmentId } : {}),
    });
    const body = await res.json();
    if (!res.ok) {
      accessToken = null;
      throw body.error; // refresh_token_missing / refresh_token_invalid → login screen
    }
    rememberSession(body.data);
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** Calls the API with the access token; on an expired token, refreshes once and retries. */
export async function api(path: string, init: RequestInit & { json?: unknown } = {}): Promise<any> {
  const send = () =>
    fetch(`${API}${path}`, {
      ...init,
      headers: {
        ...(init.json === undefined ? {} : { "Content-Type": "application/json" }),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: init.json === undefined ? init.body : JSON.stringify(init.json),
    });

  let res = await send();
  if (res.status === 401 && (await res.clone().json()).error?.code === "expired_token") {
    await refresh();
    res = await send();
  }
  if (res.status === 204) return null;
  const body = await res.json();
  if (!res.ok) throw body.error;
  return body;
}

export async function logout(): Promise<void> {
  accessToken = null;
  localStorage.removeItem("assignmentId");
  await fetch(`${API}/v1/auth/staff/logout`, { method: "POST", credentials: "include" });
}
```

Usage: `await api("/v1/organizations/<id>/branches?page=1")`, or
`await api("/v1/organizations/<id>/branches", { method: "POST", json: { code: "ADDIS", name: "Addis Office" } })`.

---

## 4. Error codes and what the screen should do

| Code | Status | Meaning | Do this |
|---|---|---|---|
| `validation_error` | 400 | The body, query or path is invalid | Show field errors from `details.issues[]` (`{ path, message, code }`, e.g. `path: "body.mobile"`) |
| `invalid_credentials` | 401 | Wrong mobile, email or password, or no access to Events | Show the message as is: "Invalid mobile number, email or password" |
| `staff_assignment_not_found` | 403 | Signed in, but no active role in this API (or the role was removed) | "You don't have access to Events yet" and back to login |
| `staff_context_required` | 409 | Refresh needs to know which role (`details.count` > 1) | Let the user pick from `assignments`, then refresh with `assignment_id` |
| `expired_token` | 401 | The access token expired | Refresh once, retry (the example does this) |
| `authentication_required`, `malformed_bearer_token`, `invalid_token`, `unsupported_token` | 401 | Missing or unusable access token | Try refresh; if that fails, go to login |
| `refresh_token_missing`, `refresh_token_invalid` | 401 | No usable session cookie | Go to login |
| `refresh_origin_not_allowed` | 403 | Your origin isn't in `AUTH_REFRESH_TRUSTED_ORIGINS` | A set-up problem, not a user error |
| `permission_denied` | 403 | This role may not do this. Since Phase 2e, `details.reason` says when nobody could: `module_unavailable` (the module is switched off) or `feature_disabled` (an organization setting turns it off, e.g. Branches without branches) | "You don't have permission"; hide the action next time. With a `details.reason`: "This part of the app is switched off" |
| `role_inactive`, `organization_inactive`, `branch_inactive`, `invalid_tenant_scope` | 409 | The role, organization or branch was deactivated | Explain, then back to login or the role picker |
| `rate_limited` | 429 | This API's limit per IP: login 10/min; refresh and logout 20/min combined | "Too many attempts, wait a minute" |
| `central_auth_rate_limited` | 429 | auth-cheche's limit, or the account is locked after failed attempts | "Too many attempts. Try again later." |
| `central_auth_unavailable` | 503 | auth-cheche is down or unreachable | "Sign-in is temporarily unavailable" |
| `central_auth_malformed_response` | 502 | auth-cheche answered something unexpected | Same as above, and report it with the `X-Request-Id` |
| `not_found`, `route_not_found` | 404 | No such record, or no such URL | |
| `conflict` | 409 | Duplicate, e.g. branch code or organization slug already used | Show the message next to the field (`details.field` when present) |
| `invalid_branch_state` | 409 | E.g. deactivating the default branch | Show the message |
| `payload_too_large` | 413 | Body over the size limit (a cover over 5 MB) | "The image must be 5 MB or smaller" |
| `unsupported_file_type` | 415 | The cover isn't a JPEG, PNG or WebP (checked by its contents, not its name) | "Upload a JPEG, PNG or WebP image" |
| `invalid_event_state` | 409 | The event is CLOSED or CANCELLED, so it can't change (including its cover) | Show the message; disable editing |
| `file_storage_unavailable` | 503 | The server couldn't store the upload | "Upload failed, try again later", and report it with the `X-Request-Id` |
| `payment_required` | 409 | Phase 7: the ticket type has a price (`details.ticket_type_code`, `price`, `currency`), so the single-ticket endpoints can't issue it | Send the buyer to checkout (step 2–3); until then, hide paid types from the single-ticket form |
| `purchase_limit_reached` | 409 | Phase 7: this mobile number already holds, or would hold, more tickets at the event than its limit (`details.limit`, `held`, `requested`) | "This number can get {limit − held} more ticket(s) for this event" |
| `registration_closed` | 409 | The event isn't taking registrations; `details.reason` is `NOT_PUBLISHED`, `CANCELLED`, `CLOSED`, `ENDED`, `NOT_OPEN_YET` or `NO_PUBLIC_TICKETS` (Phase 7: only staff-only ticket types are active) | Say why, e.g. "Registration has closed" or "Registration opens on …" |
| `capacity_reached` | 409 | No place left; `details.scope` is `EVENT` or `TICKET_TYPE` (with `details.ticket_type_code`) | "This event is full" or "No places left for this ticket type" |
| `already_registered` | 409 | The guest already holds a place at this event with another ticket type | Open their existing registration (`details.registration_id`) |
| `ticket_type_required` | 400 | The event has several active ticket types and none was chosen (`details.ticket_types`) | Ask which ticket type |
| `ticket_type_inactive`, `person_inactive` | 409 | The chosen ticket type or guest profile is switched off | Show the message |
| `privacy_notice_outdated` | 409 | The form showed an older privacy notice (`details.current` is the current version) | Reload the event page and show the current notice |
| `idempotency_key_reused` | 409 | The same `Idempotency-Key` came with a different form | Make a new key for the changed form (a bug if you see it) |
| `capacity_below_registrations` | 409 | A capacity edit would go below the confirmed registrations (`details.confirmed`) | "N guests are already confirmed; cancel some first" |
| `grant_exceeds_own_access` | 403 | A role edit would grant an action the editor doesn't hold (`details.module_code`, `details.action`) | "You can't give access you don't have yourself" |
| `role_locked` | 409 | The built-in Owner role can't be renamed, re-granted or switched off | Show Owner read only |
| `role_in_use` | 409 | Staff still hold the role (`details.active_assignments`) | "Give them another role first" |
| `module_protected` | 409 | Phase 2e. An always-on module can't be switched off, or a core module's route or permission flag can't change (`details.field`) | Show those controls read only (`always_on`, `is_core`) |
| `module_in_use` | 409 | Phase 2e. Roles, templates or overrides still grant the module (`details.grants`) | "Remove its grants first" |
| `invalid_module_state` | 409 | Phase 2e. Switching off a module with switched-on submodules (`details.active_children`), or on under a switched-off parent (`details.parent_id`) | Say which, from the message |

---

## 5. Endpoints available now

The permission column shows what the signed-in role needs: module code and action, checked per request.

| Call | Permission | Body / query |
|---|---|---|
| `POST /v1/organizations` | `ORGANIZATIONS.create`, platform role | `{ organization: { name, slug?, description?, has_branches? }, default_branch?: { code, name }, owner_mobile? }`. Creates the `OWNER` and `VIEWER` roles too. **`owner_mobile`** (Phase 2c, `09…` or `+251…`) makes that person the first Owner in the same step; the reply then has `owner: { user_id, assignment_id }`, otherwise `owner: null`. No Cheche account: `404 central_account_not_found`; already staff anywhere: `409 conflict` (`details.field: "user_id"`); either way nothing is created. `has_branches` defaults to `false`, which keeps branches hidden (see section 3). A name with no Latin letters (e.g. Amharic) needs a `slug`, or you get `400` with issue code `slug_required`. Always creates one default branch: `MAIN`, or `default_branch` when given. |
| `GET /v1/organizations` | `ORGANIZATIONS.view`, platform role | `?page&pageSize&is_active` |
| `GET /v1/organizations/{organizationId}` | `ORGANIZATIONS.view` in that organization | |
| `POST /v1/organizations/{organizationId}/branches` | `BRANCHES.create` | `{ code, name, description?, is_active? }`. `code` is letters, digits and `_`, stored upper-case. In an organization without branches, this turns branches on. |
| `GET /v1/organizations/{organizationId}/branches` | `BRANCHES.view` | `?page&pageSize&is_active` |
| `GET /v1/organizations/{organizationId}/branches/{branchId}` | `BRANCHES.view` | |
| `PATCH /v1/organizations/{organizationId}/branches/{branchId}` | `BRANCHES.update` | Any of `{ code, name, description }`. `description: null` clears it. |
| `PATCH /v1/organizations/{organizationId}/branches/{branchId}/status` | `BRANCHES.update` | `{ is_active }`. The default branch cannot be deactivated. |
| `POST /v1/organizations/{organizationId}/customer-accounts` | `CUSTOMERS.create` | A **client** commissioning events (not an attendee): `{ name, kind?, type?, primary_contact_name?, primary_contact_email?, primary_contact_phone?, is_active? }`. `kind` is `ORGANIZATION` (default) or `INDIVIDUAL`; `type` is a sector (e.g. Corporate, NGO) and must be empty for an individual (`400`, issue path `body.type`). Ethiopian mobiles come back as `+251…`. |
| `GET /v1/organizations/{organizationId}/customer-accounts` | `CUSTOMERS.view` | `?page&pageSize&is_active`. Use `is_active=true` for pickers. |
| `GET /v1/organizations/{organizationId}/customer-accounts/{customerAccountId}` | `CUSTOMERS.view` | |
| `PATCH /v1/organizations/{organizationId}/customer-accounts/{customerAccountId}` | `CUSTOMERS.update` | Any of the create fields except `is_active`; `null` clears. Changing to `INDIVIDUAL` needs `type: null` in the same request if a type is stored. |
| `PATCH /v1/organizations/{organizationId}/customer-accounts/{customerAccountId}/status` | `CUSTOMERS.update` | `{ is_active }`. Clients are deactivated, never deleted. |
| `POST /v1/organizations/{organizationId}/venues` | `EVENTS.create` | `{ name, address?, city?, country?, capacity?, is_active? }`. `country` is a two-letter code (`ET`); `capacity` describes the place (the event's own capacity comes in 3b). |
| `GET /v1/organizations/{organizationId}/venues` | `EVENTS.view` | `?page&pageSize&is_active`. |
| `GET /v1/organizations/{organizationId}/venues/{venueId}` | `EVENTS.view` | |
| `PATCH /v1/organizations/{organizationId}/venues/{venueId}` | `EVENTS.update` | Any of the create fields except `is_active`; `null` clears. |
| `PATCH /v1/organizations/{organizationId}/venues/{venueId}/status` | `EVENTS.update` | `{ is_active }`. Venues are deactivated, never deleted. |
| `PATCH /v1/organizations/{organizationId}` | `ORGANIZATIONS.update` | Any of `{ name, description, country, timezone, default_currency }` (e.g. `ET`, `Africa/Addis_Ababa`, `ETB`); `description: null` clears it. The **slug can't be changed** (it's in every public event link; sending it is `400`). Changing the timezone never changes existing events. |
| `PATCH /v1/organizations/{organizationId}/status` | `ORGANIZATIONS.update`, **platform role only** | `{ is_active }`. Switched off: its staff get `409 organization_inactive` from `/me`, sign-in and refresh, and `403` elsewhere; its events leave the catalog and their links answer 404. Switched on: everything returns. Nothing is deleted. Show this control only to the Super Admin. |
| `POST /v1/organizations/{organizationId}/events` | `EVENTS.create` | `{ name, slug?, description?, starts_at?, ends_at?, timezone?, capacity?, registration_opens_at?, registration_closes_at?, visibility?, category?, branch_id?, customer_account_id?, venue_id?, cover_file_id? }`. Created as `DRAFT`, `UNLISTED` unless you send `PUBLIC`, with a **General Admission** ticket type. Omit `slug` to generate one; omit `timezone` to use the organization's. Leave `branch_id` out (organization-wide) unless the organizer picks a branch. Phase 7: also `registration_mode` (`QUICK`/`DETAILED`, default `DETAILED`), `holder_fields` (all five of `name`, `mobile`, `email`, `affiliation`, `country`, each `REQUIRED`/`OPTIONAL`/`HIDDEN`) and `purchase_limit_per_mobile` (a positive whole number or null). |
| `GET /v1/organizations/{organizationId}/events` | `EVENTS.view` | `?page&pageSize&status&visibility`. |
| `GET /v1/organizations/{organizationId}/events/{eventId}` | `EVENTS.view` | |
| `PATCH /v1/organizations/{organizationId}/events/{eventId}` | `EVENTS.update` | Any create field; `null` clears. The slug can change only while `DRAFT`. To **stop sign-ups early**, set `registration_closes_at` (the event stays published); extend or clear it to reopen. |
| `PATCH /v1/organizations/{organizationId}/events/{eventId}/status` | `EVENTS.update` | `{ status }`: `PUBLISHED`, `CLOSED` or `CANCELLED`. Allowed: `DRAFT → PUBLISHED \| CANCELLED`, `PUBLISHED → CLOSED \| CANCELLED`. Publishing needs dates (`starts_at < ends_at`) and an active ticket type, else `409 event_not_publishable` with `details.missing` to show. |
| `POST /v1/organizations/{organizationId}/events/{eventId}/ticket-types` | `EVENTS.update` | `{ code, name, capacity?, price?, audience?, display_order?, is_active? }`. Phase 7: `price` is a decimal string (`"500"`, stored `"500.00"`; default `"0.00"` = free), in the organizer's currency (copied, never sent); `audience` is `PUBLIC` (default) or `STAFF_ONLY`. `code` is stored upper-case and unique in the event; `capacity` must fit within the event's. |
| `GET /v1/organizations/{organizationId}/events/{eventId}/ticket-types` | `EVENTS.view` | Ordered by `display_order`. |
| `PATCH /v1/organizations/{organizationId}/events/{eventId}/ticket-types/{ticketTypeId}` | `EVENTS.update` | Any of `{ code, name, capacity, price, audience, display_order }`. A price change never touches tickets already issued. |
| `PATCH /v1/organizations/{organizationId}/events/{eventId}/ticket-types/{ticketTypeId}/status` | `EVENTS.update` | `{ is_active }`. A published event keeps at least one active ticket type (`409`). |
| `PUT /v1/organizations/{organizationId}/events/{eventId}/cover` | `EVENTS.update` | `multipart/form-data` with **one file in the field `file`** and nothing else (see *Cover images* below). Replaces the current cover. Replies with the event. |
| `DELETE /v1/organizations/{organizationId}/events/{eventId}/cover` | `EVENTS.update` | No body. Removes the cover; the event comes back with `cover: null`. |

**Roles and staff (Phase 2b): the *Access Control* screens.** The menu shows *Access Control › Roles* (`/access/roles`) and *Staff Assignments* (`/access/assignments`) to owners. Since Phase 2d, *Role Templates* (`/access/role-templates`) and *Modules* (`/access/modules`) are Super Admin screens, and permission overrides live on the staff assignment's page: keep the *Permission Overrides* menu item (`USER_MODULE_ACCESSES`) hidden. Endpoints and rules: `docs/rbac-application-flow.md` ("Permission overrides, role templates and modules").

| Call | Permission | Body / query |
|---|---|---|
| `GET /v1/organizations/{organizationId}/roles` | `ROLES.view` | Each role is `{ id, code, name, description, is_active, grants: [{ module_code, module_name, view, create, update, delete, import, export, notify }] }`. |
| `GET /v1/organizations/{organizationId}/roles/{roleId}` | `ROLES.view` | One role. |
| `POST /v1/organizations/{organizationId}/roles` | `ROLES.create` | Phase 2c. `{ code, name, description?, grants: [{ module_code, view, create, update, export? }] }`. `export` is allowed on `REGISTRATIONS` only (Phase 4d); left out, it means no on create and "keep what the role has" on edit. `code` is letters, digits and `_`, stored upper-case, and **fixed afterwards**. **201** with the role. |
| `PATCH /v1/organizations/{organizationId}/roles/{roleId}` | `ROLES.update` | Any of `{ name, description, grants }`. `grants` **replaces the whole set** (send every module you want kept; `[]` removes all). |
| `PATCH /v1/organizations/{organizationId}/roles/{roleId}/status` | `ROLES.update` | `{ is_active }`. |
| `GET /v1/organizations/{organizationId}/staff-assignments` | `USER_ROLES.view` | `?is_active&page&pageSize`. Each row is `{ id, user_id, is_active, role { id, code, name }, branch { id, code, name } \| null, profile { firstname, middlename, lastname, mobile } \| null }`. |
| `GET /v1/organizations/{organizationId}/staff-lookup?mobile=` | `USER_ROLES.create` | Who uses this mobile (`09…` or `+251…`): `{ user_id, firstname, middlename, lastname, mobile }`. |
| `POST /v1/organizations/{organizationId}/roles` with `role_template_id` | `ROLES.create` | Phase 2e. Make a role from an active template: leave `grants` out to copy the template's, or send them (the edited form). Roles carry `role_template`; `GET …/roles?role_template_id=` lists a template's roles. `409 role_template_inactive`. The Super Admin's `GET /v1/role-templates/{id}/roles` lists them across organizations. |
| `POST …/staff-assignments` with `new_account` and `PATCH …/staff-assignments/{assignmentId}/profile` | `USER_ROLES.create` / `USER_ROLES.update` | Phase 2e. `new_account: { firstname, middlename?, lastname, password (8–128) }` creates a Cheche account when the mobile has none (`account_created` in the reply; show the password once, the API never returns it). `/profile` changes names only; `409 central_auth_refused`. |
| `/v1/platform/roles…` and `/v1/platform/staff-assignments…` | `ROLES` / `USER_ROLES` at platform scope | Phase 2e. Super Admin screens: platform roles (any module, all 7 actions; `SUPER_ADMIN` read-only) and platform staff (by mobile, optional `new_account`). Errors: `409 role_locked`, `409 role_in_use`, `409 last_super_admin`, `409 own_assignment`, `409 conflict` (`field: user_id`: staff of an organization). |
| `GET /v1/organizations/{organizationId}/grantable-modules` | `ROLES.view` or `USER_ROLES.view` | Phase 2e. `[{ module_code, module_name, sno, actions }]`: build the role, template and override grids from it. All 7 actions are grantable on tenant modules (Organizations never create or delete); `delete`, `import`, `export`, `notify` may be left out of a grant. |
| `GET`, `POST /v1/modules`; `PATCH /v1/modules/{moduleId}`, `PATCH /v1/modules/{moduleId}/status` | `MODULES` view, create, update at platform scope | Phase 2e (Super Admin). Each node is `{ id, code, module_name, description, parent_id, sno, icon, route_name, is_menu, is_permission, is_active, is_core, always_on, children }`. Create: `{ code, module_name, description?, parent_id?, sno?, icon?, route_name?, is_menu, is_permission }` (a menu group, link or platform-role module; never grantable to organizations). Edit: any of the display fields plus `parent_id`, `route_name`, `is_menu`, `is_permission`. Status: `{ is_active }`; switched off, nobody can use it, the Super Admin included. Errors: 400 (`issues[].code` `parent_not_found`, `parent_inactive`, `parent_cycle`), `409 conflict` (code), `409 module_protected`, `409 module_in_use`, `409 invalid_module_state`. |
| `DELETE /v1/organizations/{organizationId}/staff-assignments/{assignmentId}` | `USER_ROLES.delete` | Phase 2e. Deletes the assignment and its overrides; 204. `409 last_owner_assignment`, `409 own_assignment`. |
| `GET /v1/organizations/{organizationId}/staff-assignments/{assignmentId}` | `USER_ROLES.view` | Phase 2e. One assignment with the person's name. The list also takes `?role_id` (a role's members) and `?branch_id`. Roles carry `grant_count` and `member_count`; templates `grant_count`. `409 assignment_scope_conflict`: the same role organization-wide and on a branch. |
| `POST /v1/organizations/{organizationId}/staff-assignments` | `USER_ROLES.create` | `{ mobile, role_id, branch_id? }`. **201** = role given (new or reactivated); **200** = they already had it. |
| `PATCH /v1/organizations/{organizationId}/staff-assignments/{assignmentId}` | `USER_ROLES.update` | `{ role_id?, branch_id? }`; `branch_id: null` makes it organization-wide again. |
| `PATCH /v1/organizations/{organizationId}/staff-assignments/{assignmentId}/status` | `USER_ROLES.update` | `{ is_active }`. |

**The "add staff" flow:**
1. The owner types a mobile number.
2. Call `staff-lookup` and show the name it returns, so the owner can confirm it's the right person.
3. The owner picks a role (from `GET /roles`) and, only if the organization has branches, a branch.
4. `POST` with the same `mobile`. The API looks the number up again itself, so never send a `user_id`.

**What to show:**
- **404 `central_account_not_found`:** "This number has no Cheche account yet. Ask them to sign up first, then try again." The API never creates accounts.
- **409 `conflict`:** "This person is already staff of another organization."
- **409 `last_owner_assignment`:** "The organization needs at least one active Owner." Disable *Deactivate* and *Change role* on the only active Owner.
- **409 `invalid_branch_state`:** the organization has no branches. Hide the branch picker when `has_branches` is false.
- **503 `central_auth_unavailable`:** "Cheche accounts can't be reached right now. Try again."
- **`profile: null`** on a row means the name couldn't be read just now. Show the role and status anyway, with a dash for the name.

A changed role applies on the person's next request; there's no need to sign out.

**Creating and editing roles (Phase 2c).** Owners have `ROLES` view, create and update.
- **The grant grid:** one row per module, with *View*, *Create* and *Update* boxes. Only these may be ticked; leave other boxes out of the screen:

  | Module | Allowed |
  |---|---|
  | `ORGANIZATIONS` | view, update |
  | `BRANCHES`, `ROLES`, `USER_ROLES`, `EVENTS`, `CUSTOMERS`, `REGISTRATIONS` | view, create, update |

  Module names for the rows come from the roles you already read (`grants[].module_name`), or from `/me` navigation. `MODULES`, `ROLE_TEMPLATES` and `USER_MODULE_ACCESSES` are never offered.
- **The built-in `OWNER` role is read only:** show it without edit or switch-off controls. `VIEWER` and every created role are editable.
- **What to show:**
  - **400 `validation_error`** with `details.issues[].path` like `body.grants.2.create`: "This access can't be given to an organization's role." (A bug if the grid only offers allowed boxes.)
  - **403 `grant_exceeds_own_access`** (`details.module_code`, `details.action`): "You can't give access you don't have yourself (Events › create)."
  - **409 `conflict`** with `details.field` `code` or `name`: "Another role already uses this code" / "this name", next to the field.
  - **409 `role_locked`:** "The Owner role can't be changed."
  - **409 `role_in_use`** (`details.active_assignments`): "N staff still have this role. Give them another role first, then switch it off." Link to Staff Assignments.
  - **409 `role_inactive`** when adding staff with a switched-off role: hide switched-off roles from the role picker.

**A new organization** (`POST /v1/organizations`) comes with the default **Owner** and **Viewer** roles, but with no staff yet. After creating one, the Super Admin opens its *Staff Assignments* and adds the first Owner by mobile. A good place for that is a "Next: add the owner" step right after the create form. Organizations created before this fix get the two roles from a one-off migration.

**Event dates and times.** Send instants with an offset or `Z` (`2027-03-12T09:00:00+03:00`); the API answers in
UTC (`…Z`). Show them in the event's own `timezone`. Show `display_status` for the badge: it is `LIVE` while a
published event is running; a cancelled event shows `CANCELLED` even during its hours. `CLOSED` and `CANCELLED`
events can't be edited (`409 invalid_event_state`).

**Cover images.** Every staff event reply, public card and public page has `cover`: `{ url }` or `null`. `url` is a
**path** such as `/assets/uploads/events/covers/<uuid>.png`, so put the API's origin in front of it
(`<img src={API_ORIGIN + event.cover.url}>`). The image is public and needs no token. To upload, send the file with
`FormData` and **don't set `Content-Type` yourself**; the browser adds it with the boundary:

```ts
const form = new FormData();
form.append("file", input.files[0]); // JPEG, PNG or WebP, up to 5 MB
const response = await fetch(`${API_ORIGIN}/v1/organizations/${organizationId}/events/${eventId}/cover`, {
  method: "PUT",
  headers: { Authorization: `Bearer ${accessToken}` },
  body: form,
});
// 200: { data: event } with event.cover.url. 400: not exactly one file in "file". 413: over 5 MB.
// 415: not a JPEG/PNG/WebP. 409: the event is CLOSED or CANCELLED.
```

Check the size and type in the browser too, for a quicker message, but the API's check is the one that counts.
Don't send any other form field with the file; it is refused. `cover_file_id` on the event is the stored file's
id. Use the cover endpoints to change it rather than sending `cover_file_id` in the event body.

**Public pages (no login, no token).** For the visitor site:

| Call | Notes |
|---|---|
| `GET /v1/public/events` | The catalog: upcoming and live published `PUBLIC` events, soonest first. `?page&pageSize&category&organization` (`category` exact, ignoring case; `organization` = organization slug). Each card: `name`, `slug`, `organization { name, slug }`, `starts_at`, `ends_at`, `timezone`, `display_status`, `category`, `venue` (or null), `cover` (`{ url }` or null; see *Cover images*), `registration_open`. Link a card to `/{organization.slug}/{slug}`. |
| `GET /v1/public/organizations/{organizationSlug}/events/{eventSlug}` | The event page. Works for `UNLISTED` events too (share the link), and keeps working after the event ends, closes or is cancelled (show `display_status`). Adds `description`, `registration_opens_at`, `registration_closes_at`, `ticket_types [{ code, name }]`. `404` for drafts. Phase 7: `ticket_types` lists active PUBLIC types as `{ code, name, price, currency, is_free }`; the page also carries `registration_mode`, `holder_fields` and `purchase_limit_per_mobile`. |
| `POST /v1/public/organizations/{organizationSlug}/events/{eventSlug}/orders` | Phase 7 checkout, no login needed (a guest token is optional). Idempotency-Key required. `{ buyer_mobile?, privacy_notice_version, items: [{ ticket_type_code, quantity, holders? }] }`; `buyer_mobile` is required without an account (the codes are sent there); signed in, the account's mobile is used and the tickets show in My Tickets. **201** `{ reference, status, total_amount, currency, event, organization, tickets: [{ code, status, ticket_type, price, holder }] }`; the same key and body again is 200 with the same codes. Show every code on screen: the SMS can be late. |

Use `registration_open` to show or hide the sign-up button.

**Guest accounts and My Tickets (Phase 6).** Guests sign up and sign in through `/v1/auth/customer/*` (Cheche
accounts; the full table is in `docs/authentication.md`, "Guest accounts"). Keep the guest's access token in memory
only, like the staff token; the refresh token stays in the HttpOnly `events_customer_refresh` cookie, renewed with
`POST /v1/auth/customer/refresh`. Send the guest token only on `/v1/customer/*`, `/v1/auth/customer/me` and the public
registration POST. Errors to handle: `409 account_exists` ("You already have a Cheche account. Sign in", then switch to
sign-in), `404 account_not_found` (offer sign-up), `400 invalid_code`, `401 invalid_credentials`, `429 rate_limited`
(3 codes every 10 minutes per mobile), `429 central_auth_rate_limited`. My Tickets is
`GET /v1/customer/registrations` (only registrations made while signed in). A guest who registered before having an
account can register again for the same event when signed in: it's a separate profile until claiming is built.

**Public registration (Phase 4b, no login; Phase 6, optionally signed in).** With a guest token, `phone` is ignored
and may be left out: the account's mobile is used, and registering again for the same event returns 200 with the same
code.
`POST /v1/public/organizations/{organizationSlug}/events/{eventSlug}/registrations`, with the header
`Idempotency-Key: <uuid>` and the body
`{ first_name, last_name, phone, email?, affiliation_name?, country?, ticket_type_code?, privacy_notice_version }`.
- **The fields:**
  - `phone` must be an Ethiopian mobile (`09…` or `+251…`), because the confirmation SMS goes there;
  - `ticket_type_code` is one of the page's `ticket_types[].code`, needed only when there are several;
  - `privacy_notice_version` is the event page's `privacy_notice.version`. Show the notice on the form, and send back the version you showed.
- **The key:**
  - create a new UUID (`crypto.randomUUID()`) when the visitor presses *Register*;
  - reuse it if you retry that same submission automatically, after a network error or timeout;
  - make a new one if they change the form and submit again. The same key with a different form gets `409 idempotency_key_reused`.
- **Success:** both **201** (registered) and **200** (that same submission was already processed) are success. Show `data.code`: it's the guest's registration code, also sent by SMS.
- **Refusals:** `registration_closed` and `capacity_reached` as for staff (section 4), `privacy_notice_outdated` (reload the page), `rate_limited` (10 submissions a minute per IP), and 404 when the event isn't public.
- **What the reply contains:** only what the visitor needs: `code`, `status`, `ticket_type`, `event`, `organization`, `guest.first_name`. No ids.

Staff may also send an optional `Idempotency-Key` on `POST …/events/{eventId}/registrations`; a repeat then answers
200 "Same request already processed". Public routes are
rate limited (`429 rate_limited` after 120 requests a minute per IP). The visitor site's origin must be in
`CORS_ALLOWED_ORIGINS`.

**Guests and registrations (Phase 4a, staff).** The menu gains *Event Management › Guests* (`/guests`, module
`REGISTRATIONS`: owners view, create and update; viewers view). Details in `docs/registrations.md`.

| Call | Permission | Body / query |
|---|---|---|
| `POST /v1/organizations/{organizationId}/persons` | `REGISTRATIONS.create` | A guest profile: `{ first_name, last_name?, email?, phone?, affiliation_name?, country?, is_active? }`. Only `first_name` is required; Ethiopian mobiles come back as `+251…`. |
| `GET /v1/organizations/{organizationId}/persons` | `REGISTRATIONS.view` | `?q&is_active&page&pageSize`. `q` searches names, email and phone (`09…` also finds `+251…`). Use it to find a returning guest. |
| `GET /v1/organizations/{organizationId}/persons/{personId}` | `REGISTRATIONS.view` | The profile with `registrations[]` (event, ticket type, status, code) in this organization: show them so staff can confirm it's the same person before selecting the profile. |
| `PATCH /v1/organizations/{organizationId}/persons/{personId}` and `…/status` | `REGISTRATIONS.update` | Edit fields (`null` clears), or `{ is_active }`. |
| `POST /v1/organizations/{organizationId}/events/{eventId}/orders` | `REGISTRATIONS.create` | Phase 7 checkout by staff: `{ buyer_mobile?, items: [{ ticket_type_id, quantity, holders? }] }` (each type once, at most 20 tickets; DETAILED events need one holder per ticket following `holder_fields`, QUICK events none). Staff-only types allowed. **201** with the order: `{ id, reference, status, source, buyer_mobile, total_amount, currency, ticket_count, tickets: [{ id, code, status, ticket_type, price, holder }], confirmation }`; optional Idempotency-Key (a replay is 200). Errors: 400 (`issues[].path` names the item and holder), 404, `registration_closed`, `capacity_reached` (`remaining`), `purchase_limit_reached`, `payment_required` (paid checkout comes in step 3). |
| `GET /v1/organizations/{organizationId}/events/{eventId}/orders`, `GET …/orders/{orderId}` | `REGISTRATIONS.view` | Phase 7. The list (`?buyer_mobile&page&pageSize`) has no tickets; one order has its tickets, holders and the buyer's SMS status. |
| `POST /v1/organizations/{organizationId}/events/{eventId}/registrations` | `REGISTRATIONS.create` | `{ person_id }` for a confirmed returning guest, **or** `{ person: {...} }` for a new one; plus `ticket_type_id` when the event has several active ticket types. **201** = a place was taken (new or reactivated; check `message`), **200** = this guest was already registered with that ticket type (nothing changed). |
| `GET /v1/organizations/{organizationId}/events/{eventId}/registrations` | `REGISTRATIONS.view` | The guest list, newest first: `?status&ticket_type_id&q&page&pageSize`. Each row: `code`, `status`, `source`, `registered_at`, `person {…}`, `ticket_type {…}`. |
| `GET /v1/organizations/{organizationId}/events/{eventId}/registrations/summary` | `REGISTRATIONS.view` | `{ capacity, confirmed, remaining, ticket_types[] }` for a "12 of 50 places taken" display (`remaining: null` = no limit). |
| `PATCH /v1/organizations/{organizationId}/events/{eventId}/registrations/{registrationId}/status` | `REGISTRATIONS.update` | `{ status: "CANCELLED" }` frees the place; `{ status: "CONFIRMED" }` brings a cancelled guest back if there is room. |
| `PATCH /v1/organizations/{organizationId}/events/{eventId}/registrations/{registrationId}/ticket-type` | `REGISTRATIONS.update` | Phase 4d. `{ ticket_type_id }` moves a confirmed guest to another ticket type of the event: same code, no SMS. PUBLISHED events only. Errors: `409 registration_cancelled`, `409 ticket_type_inactive`, `409 capacity_reached` (`scope: TICKET_TYPE`), `409 invalid_event_state`. 200 either way; `message` says "Ticket type changed" or "Ticket type unchanged". |
| `GET /v1/organizations/{organizationId}/events/{eventId}/registrations/export` | **`REGISTRATIONS.export`** | Phase 4d. The guest list as a CSV file: `?status&ticket_type_id&q` (no paging). Not the JSON envelope: read it as a blob with the bearer token and save it as `{event.slug}-guests.csv`. Errors are JSON as usual. Show the download only when `/me` `permissions.REGISTRATIONS.export` is true. |

Registration follows the same rules for staff as for the public form: the event must be **published**, not ended,
inside its registration window, with an active ticket type and a free place. Show `registration_closed` and
`capacity_reached` (see section 4) instead of a generic error. A guest with an Ethiopian mobile gets a confirmation
SMS with their code. Each staff registration reply has `confirmation: { status, sent_at } | null`. The status is
`PENDING` (being sent), `SENT`, `FAILED` (gave up after 5 tries) or `SKIPPED` (too many to one number, or the daily
limit). `null` means there was no Ethiopian mobile, so no SMS. Show it as a small badge on the guest list.

The menu gains *Event Management › Events* (`/events`) and *Clients* (`/clients`), above *Administration*. Venues
have no menu item of their own: reach them from the Events area (they use the `EVENTS` permission). These routes
are organization-level: branch-limited staff get `403` for now.

---

## 6. Production notes

- Cookies are `Secure` in production, so the app and API must be served over HTTPS.
- With `SameSite=lax` (the default), the app and the API must share a registrable domain, e.g.
  `app.example.et` and `api.example.et`. On different domains, set `AUTH_REFRESH_COOKIE_SAME_SITE=none`.
- If the API sits behind a path prefix such as `https://example.et/api/...`, set
  `AUTH_REFRESH_COOKIE_PATH_PREFIX=/api`, or the browser will not send the cookies.
- `AUTH_REFRESH_TRUSTED_ORIGINS` and `CORS_ALLOWED_ORIGINS` must list the production app origin.

---

## 7. Not available yet

- **Real auth-cheche sign-in is not yet verified end to end** (the live check is pending the real values). Report
  anything odd at login together with the `X-Request-Id`.
