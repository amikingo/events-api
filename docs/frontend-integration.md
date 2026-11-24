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
                   "organization": { "id": "…", "name": "Selam Events" }, "branch": null },
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

Two menu details:

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
| `permission_denied` | 403 | This role may not do this | "You don't have permission"; hide the action next time |
| `role_inactive`, `organization_inactive`, `branch_inactive`, `invalid_tenant_scope` | 409 | The role, organization or branch was deactivated | Explain, then back to login or the role picker |
| `rate_limited` | 429 | This API's limit per IP: login 10/min; refresh and logout 20/min combined | "Too many attempts, wait a minute" |
| `central_auth_rate_limited` | 429 | auth-cheche's limit, or the account is locked after failed attempts | "Too many attempts. Try again later." |
| `central_auth_unavailable` | 503 | auth-cheche is down or unreachable | "Sign-in is temporarily unavailable" |
| `central_auth_malformed_response` | 502 | auth-cheche answered something unexpected | Same as above, and report it with the `X-Request-Id` |
| `not_found`, `route_not_found` | 404 | No such record, or no such URL | |
| `conflict` | 409 | Duplicate, e.g. branch code or organization slug already used | Show the message next to the field (`details.field` when present) |
| `invalid_branch_state` | 409 | E.g. deactivating the default branch | Show the message |
| `payload_too_large` | 413 | Body over the size limit | |

---

## 5. Endpoints available now

The permission column shows what the signed-in role needs: module code and action, checked per request.

| Call | Permission | Body / query |
|---|---|---|
| `POST /v1/organizations` | `ORGANIZATIONS.create`, platform role | `{ organization: { name, slug?, description? }, default_branch?: { code, name } }`. A name with no Latin letters (e.g. Amharic) needs a `slug`, or you get `400` with issue code `slug_required`. Creates a `MAIN` branch unless `default_branch` is given. |
| `GET /v1/organizations` | `ORGANIZATIONS.view`, platform role | `?page&pageSize&is_active` |
| `GET /v1/organizations/{organizationId}` | `ORGANIZATIONS.view` in that organization | |
| `POST /v1/organizations/{organizationId}/branches` | `BRANCHES.create` | `{ code, name, description?, is_active? }`. `code` is letters, digits and `_`, stored upper-case. |
| `GET /v1/organizations/{organizationId}/branches` | `BRANCHES.view` | `?page&pageSize&is_active` |
| `GET /v1/organizations/{organizationId}/branches/{branchId}` | `BRANCHES.view` | |
| `PATCH /v1/organizations/{organizationId}/branches/{branchId}` | `BRANCHES.update` | Any of `{ code, name, description }`. `description: null` clears it. |
| `PATCH /v1/organizations/{organizationId}/branches/{branchId}/status` | `BRANCHES.update` | `{ is_active }`. The default branch cannot be deactivated. |

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

- **Events, ticket types, registrations, public event pages:** Phases 3–4 of the plan.
- **Real auth-cheche sign-in is not yet verified end to end** (the live check is pending the real values). Report
  anything odd at login together with the `X-Request-Id`.
