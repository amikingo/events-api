# Backend Module Standard (TypeScript)

Node 24, TypeScript (strict, ESM), Express 5, Sequelize 6, PostgreSQL, Zod 4, Umzug migrations, centralized
errors, multi-tenant RBAC. Follow the existing `src/` layer folders. Do not introduce a parallel architecture.

## Default flow

`route → requireXAuthentication → validate(contract) → requirePermission({ moduleCode, action, scope }) → controller → service → repository → model/PostgreSQL → errorHandler`

| Layer | Owns | Must not |
|---|---|---|
| Route | path, method, middleware chain per endpoint | logic; importing services/repositories/models/db; `router.use(auth)` |
| Validator | Zod transport shapes (`z.strictObject`), normalization, one contract object per endpoint | DB access; data-dependent invariants |
| Controller | `getValidated(req, contract)` + `req.auth` → one service call → `sendSuccess`/`sendList`/`sendNoContent` | queries, transactions, rules, tenant checks |
| Service | business rules, cross-repository coordination, `runTransaction`, deliberate results | Express, models/Sequelize values, HTTP responses |
| Mapper (optional) | pure response shaping for non-trivial or reused contracts | queries, authorization, validation |
| Repository | tenant-scoped persistence, explicit attributes, locks, plain typed rows | HTTP input, Zod, workflows, commit/rollback |
| Model | columns, table, associations (`init-associations.ts`) | business hooks, `sync()` |

Every controller/service/repository module exports **one object**; callers call through it and never destructure it
(this is what makes `mock.method` work under ESM).

## Resource modules

`one resource → route file → validator file (one contract per endpoint) → controller → service → repository → model + migration → openapi/v1.ts entries → tests → docs/<feature>.md`

Valid exceptions: aggregate service (atomic multi-repository use case), thin composition router, mapper (non-trivial,
reused response shape), narrow shared utility (identical behaviour, narrowly named).

Prohibited: dummy wrappers, pass-through proxies, import-and-re-export aliases, mega-services/repositories behind
resource names, generic CRUD or route factories, routes importing repositories, services importing models.

## Multi-tenancy

- Every tenant-owned table: `organization_id NOT NULL` + `UNIQUE (organization_id, id)`; children use composite FKs
  `(organization_id, parent_id) → parent(organization_id, id)`.
- Every tenant operation includes `organization_id` (reads, writes, status changes, uniqueness/dependency checks,
  counts, read-back, raw SQL). An id alone is never a tenant boundary.
- Tenant id comes from the validated path param (`/v1/organizations/:organizationId/...`), never from body or query.

## Authorization

- `requirePermission` always declares `scope`: `"platform"` for platform-wide resources, a resolver
  (`organizationScopeFromParams`) for tenant resources. Tenant assignments never satisfy platform scope.
- New permission modules: add the code to `utils/module-codes.ts` **and** a migration inserting the `module` row.
- Navigation and permissions for the UI come from `GET /v1/auth/staff/me`; frontend checks are UX only.

## Validation and contracts

- Unknown fields rejected (`z.strictObject`); never accept audit fields or tenant ids in bodies.
- Services own database-backed invariants; DB constraints are the backstop (mapped to 409/400).
- Every endpoint: one contract, one `validate(contract)`, one `v1Operations` entry (`bodyComponent` iff body).
  `tests/openapi.test.ts` enforces this both ways. Run `npm run openapi` when contracts change.

## PATCH semantics

Omitted/`undefined` keeps, explicit `null` clears, value replaces. Persist only allow-listed fields via `pickDefined`.

## Transactions

Services own managed transactions (`runTransaction`). Every repository call inside gets `{ transaction }`.
Throwing rolls back. Repositories never commit or roll back. Use `{ lock: true }` (FOR UPDATE) or
`acquireAdvisoryXactLock` for concurrency-sensitive invariants.

## Migrations and models

- New schema change = new migration (`npm run db:migration:create -- --name <kebab>`); never edit an applied one;
  never `sync()`; never share helpers between migrations.
- Name every constraint/index; `down()` is the exact inverse; triggers are backstops raising SQLSTATE codes.
- Models and migrations stay aligned; never share one attribute-definition object between attributes.
- Agents never run migrations without explicit instruction. Document tables in `docs/database-foundation.md`.

## Routes and versions

- `routes/index.ts` mounts each major version once; `routes/v1/index.ts` mounts each resource router once with an
  explicit literal prefix; nested routers use `mergeParams`.
- Breaking changes need a new major version (see `docs/api-versioning.md`).

## Implementation checklist

Before: read AGENTS.md + this standard; inspect an analogous module; identify ownership, tenant boundary,
permission module + scope, transaction boundary, API contract; list files; reject unnecessary abstractions.

During: resource-owned files; thin controllers; transactions in services; tenant-scoped repositories; contract +
operation entry per endpoint; migration + module seed for new permission modules; feature doc.

After: `npm run check`; integration tests when schema changed; `npm run openapi` when contracts changed; search for
wrappers/dead files/duplicate helpers; inspect `git diff`; report anything not verified.

## Architecture decision rule

Do not add a folder, layer, base class, generic factory, dependency, or convention because it is common elsewhere.
First prove the current architecture cannot cleanly support the requirement, that the abstraction removes repeated
concrete behaviour, that it has a clear owner, and that the change is approved.
