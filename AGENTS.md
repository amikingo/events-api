# AGENTS.md

Rules for any coding agent working in this repository.

## Before writing code

1. Read `docs/architecture/backend-module-standard.md`. It is binding.
2. Inspect the closest existing module (e.g. `branch`: route, validator, controller, service, repository, model,
   migration, tests) and follow its shape exactly.
3. State the plan: files to create/change, tenant boundary, permission module + scope, transaction boundary,
   API contract changes.

## While writing code

- One resource, one file per layer; layer modules export one object; callers never destructure it.
- Every endpoint: `requireXAuthentication` → `validate(contract)` → `requirePermission({ …, scope })` → controller.
- Every endpoint has an entry in `src/openapi/v1.ts`.
- Schema changes are new migrations only. Do not run migrations unless explicitly asked.
- No new dependency, folder, base class, or abstraction without explicit approval (architecture decision rule).
- Never put secrets in code, Dockerfiles, CI build args, or tests.

## Before saying "done"

Run `npm run check` (typecheck, lint, tests, OpenAPI snapshot check). If the schema changed and a disposable
database is available, also run the integration tests (`TEST_DATABASE=1`). Report exactly what was and was not
verified.

## Git

Never run commands that change Git state or talk to a remote (`add`, `commit`, `push`, `pull`, `merge`, `rebase`,
`reset`, `checkout`, `stash`, tags, branches, PRs). Read-only inspection (`status`, `diff`, `log`) is fine.
When asked to "commit", propose atomic commits with `type(scope): imperative summary` messages instead.
