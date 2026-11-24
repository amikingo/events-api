# events-api

Layered, multi-tenant TypeScript API (Express 5, Sequelize 6, PostgreSQL, Zod 4).
Architecture: `docs/architecture/backend-module-standard.md`. Agent rules: `AGENTS.md`.

## Prerequisites

Node 24, PostgreSQL 15+ (uses `gen_random_uuid()`, `num_nonnulls()`).

## Setup

```bash
npm ci
cp .env.example .env          # fill in database + auth values
npm run db:migrate            # applies migrations (incl. platform modules + SUPER_ADMIN role)
npm run bootstrap:super-admin -- --user-id <central-auth-user-uuid>            # preview
npm run bootstrap:super-admin -- --user-id <central-auth-user-uuid> --confirm  # apply
npm run dev                   # http://localhost:5010/v1/docs
```

## Scripts

| Script | Purpose |
|---|---|
| `dev` / `build` / `start` | tsx watch / compile to `dist/` / run compiled server |
| `typecheck` / `lint` / `test` | `tsc --noEmit` / ESLint with layer rules / node:test |
| `check` | everything CI runs: typecheck, lint, test, openapi:check |
| `db:migrate` / `db:migrate:undo` / `db:migrate:status` | Umzug migrations (`-- --to <name>` or `-- --to 0`) |
| `db:migration:create -- --name <kebab>` | scaffold a timestamped migration |
| `openapi` / `openapi:check` | write / verify `docs/api/openapi-v1.json` |
| `bootstrap:super-admin` | preview/apply the platform SUPER_ADMIN assignment |
| `provision:organizer` | preview/apply a new organization with its MAIN branch, OWNER/VIEWER roles and owner |
| `assign:staff` | preview/apply a staff assignment (organization-wide or one branch) |
| `dev:staff-token` | development only: print a staff token for a person, without auth-cheche |

Integration tests: `TEST_DATABASE=1 POSTGRES_…=… npm test` against a **disposable** database (they migrate
up and fully down). Test files run one at a time (`--test-concurrency=1`), so the integration files never share
the database at the same moment.

## Production

`docker build .` → image runs `node dist/server.js`. Run migrations once per deploy as a job:
`node dist/scripts/migrate.js up`. All configuration and secrets come from the runtime environment.
Probes: `GET /health/live`, `GET /health/ready`.
