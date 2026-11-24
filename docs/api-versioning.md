# API Versioning

The API uses URL path versioning. All current endpoints are served under `/v1`, composed in `src/routes/v1/index.ts`
and mounted once by `src/routes/index.ts`. Adding a router to a version never grants access to it: every route keeps
its own authentication and `requirePermission` declaration.

## Compatible changes (stay in the current major version)

- new endpoints
- new optional request fields; new response fields
- bug fixes that restore the documented contract
- stricter validation of input that was already documented as invalid

## Breaking changes (need a new major version)

- removing or renaming an endpoint or field
- changing a field's type or meaning
- making an optional request field required
- changing authentication/authorization requirements incompatibly
- changing status-code or envelope semantics clients rely on

## Adding a major version

Create `src/routes/v2/`, compose it in `src/routes/v2/index.ts`, mount it once at `/v2` in `src/routes/index.ts`,
and add `src/openapi/v2.ts`. A new version may reuse services and repositories while their behaviour is compatible,
but owns its routes, contracts, and transport shapes. Versions may run concurrently; never redirect one major version
to another or silently make a v1 route execute a v2 contract.

## Deprecation

Keep a version available until a retirement date is approved and communicated. Send `Deprecation`, `Sunset`, and a
`Link` header only when a migration target and schedule exist. Remove a version only after confirming no client
still calls it.

## OpenAPI

`src/openapi/v1.ts` lists every operation with the same contract objects the routes validate with. The document is
served at `/v1/openapi.json` (UI at `/v1/docs`) and snapshotted to `docs/api/openapi-v1.json`; CI fails when the
snapshot is stale. Regenerating must not remove paths unless the API change was approved.
