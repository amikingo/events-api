import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { createApp } from "../src/app.js";
import { branchService } from "../src/services/branch.service.js";
import { permissionResolutionService, type PermissionScope } from "../src/services/permission-resolution.service.js";
import { branchRow, IDS, staffToken } from "./helpers/fixtures.js";
import { call, withServer } from "./helpers/http.js";

/**
 * HTTP-level test of the real wiring (auth -> validate -> permission -> controller -> envelope).
 * Only the permission engine and the service are stubbed; tokens are really signed and verified.
 */
const app = createApp();
const path = `/v1/organizations/${IDS.orgA}/branches`;

function allowPermissions(allowed: boolean) {
  return mock.method(permissionResolutionService, "resolvePermission", async (input: { scope: PermissionScope }) => ({
    allowed,
    source: allowed ? ("role_permission" as const) : ("default_deny" as const),
    scope: input.scope,
    roleIds: [],
  }));
}

afterEach(() => mock.restoreAll());

test("missing and invalid bearer tokens are rejected with the error envelope", async () => {
  await withServer(app, async (baseUrl) => {
    const missing = await call(baseUrl, "GET", path);
    assert.equal(missing.status, 401);
    assert.deepEqual(missing.body, { success: false, error: { code: "authentication_required", message: "Bearer token is required" } });

    const invalid = await call(baseUrl, "GET", path, { token: "not-a-jwt" });
    assert.equal(invalid.status, 401);
    assert.equal(invalid.body.error.code, "invalid_token");
  });
});

test("unknown body fields are rejected before authorization and the service run", async () => {
  const permission = allowPermissions(true);
  const create = mock.method(branchService, "createBranch", async () => branchRow());

  await withServer(app, async (baseUrl) => {
    const response = await call(baseUrl, "POST", path, { token: staffToken(), body: { code: "x", name: "X", surprise: 1 } });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "validation_error");
    assert.equal(response.body.error.details.issues[0].path, "body");
  });
  assert.equal(permission.mock.callCount(), 0);
  assert.equal(create.mock.callCount(), 0);
});

test("permission is resolved for the path's organization and the token's assignment, and denial stops the request", async () => {
  const permission = allowPermissions(false);
  const create = mock.method(branchService, "createBranch", async () => branchRow());

  await withServer(app, async (baseUrl) => {
    const response = await call(baseUrl, "POST", path, { token: staffToken({ organizationId: IDS.orgB }), body: { code: "north", name: "North" } });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "permission_denied");
  });
  assert.deepEqual(permission.mock.calls[0]?.arguments[0], {
    userId: IDS.user,
    assignmentId: IDS.assignment, // only the signed-in assignment counts, never all of the user's roles
    scope: { level: "organization", organizationId: IDS.orgA, branchId: null },
    moduleCode: "BRANCHES",
    action: "create",
  });
  assert.equal(create.mock.callCount(), 0);
});

test("an allowed request reaches the service with normalized, typed input", async () => {
  allowPermissions(true);
  const create = mock.method(branchService, "createBranch", async () => branchRow({ code: "NORTH" }));

  await withServer(app, async (baseUrl) => {
    const response = await call(baseUrl, "POST", path, { token: staffToken(), body: { code: " north ", name: "North", description: "" } });
    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.equal(response.body.data.code, "NORTH");
    assert.equal(response.body.message, "Branch created");
  });
  assert.deepEqual(create.mock.calls[0]?.arguments, [IDS.orgA, { code: "NORTH", name: "North", description: null }, IDS.user]);
});

test("malformed JSON and unknown routes map to stable error codes", async () => {
  await withServer(app, async (baseUrl) => {
    const malformed = await call(baseUrl, "POST", path, { token: staffToken(), rawBody: "{not json" });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.message, "Malformed JSON body");

    const unknown = await call(baseUrl, "GET", "/v1/nope?token=secret");
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, "route_not_found");
    assert.ok(!JSON.stringify(unknown.body).includes("secret"), "query strings are never echoed");
  });
});
