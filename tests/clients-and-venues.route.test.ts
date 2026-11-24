import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { createApp } from "../src/app.js";
import { customerAccountService } from "../src/services/customer-account.service.js";
import { permissionResolutionService, type PermissionScope } from "../src/services/permission-resolution.service.js";
import { venueService } from "../src/services/venue.service.js";
import { customerAccountRow, IDS, staffToken, venueRow } from "./helpers/fixtures.js";
import { call, withServer } from "./helpers/http.js";

/**
 * HTTP-level tests of the client (customer_account) and venue routes: real auth, validation and envelope; the
 * permission engine and the services are stubbed.
 */
const app = createApp();
const clientsPath = `/v1/organizations/${IDS.orgA}/customer-accounts`;
const venuesPath = `/v1/organizations/${IDS.orgA}/venues`;

function allowPermissions(allowed: boolean) {
  return mock.method(permissionResolutionService, "resolvePermission", async (input: { scope: PermissionScope }) => ({
    allowed,
    source: allowed ? ("role_permission" as const) : ("default_deny" as const),
    scope: input.scope,
    roleIds: [],
  }));
}

afterEach(() => mock.restoreAll());

test("clients use the CUSTOMERS module and venues the EVENTS module, scoped to the path's organization", async () => {
  const permission = allowPermissions(false);

  await withServer(app, async (baseUrl) => {
    assert.equal((await call(baseUrl, "POST", clientsPath, { token: staffToken(), body: { name: "ABC Bank" } })).status, 403);
    assert.equal((await call(baseUrl, "GET", venuesPath, { token: staffToken() })).status, 403);
  });

  const scope = { level: "organization", organizationId: IDS.orgA, branchId: null };
  const requested = permission.mock.calls.map((entry) => entry.arguments[0] as { moduleCode: string; action: string; scope: unknown });
  assert.deepEqual(
    requested.map((input) => [input.moduleCode, input.action, input.scope]),
    [
      ["CUSTOMERS", "create", scope],
      ["EVENTS", "view", scope],
    ],
  );
});

test("an individual client cannot have a sector type, and nothing reaches the service", async () => {
  const permission = allowPermissions(true);
  const create = mock.method(customerAccountService, "createCustomerAccount", async () => customerAccountRow());

  await withServer(app, async (baseUrl) => {
    const response = await call(baseUrl, "POST", clientsPath, {
      token: staffToken(),
      body: { name: "Hana Bekele", kind: "INDIVIDUAL", type: "Corporate" },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "validation_error");
    assert.equal(response.body.error.details.issues[0].path, "body.type");
  });
  assert.equal(permission.mock.callCount(), 0, "validation runs before authorization");
  assert.equal(create.mock.callCount(), 0);
});

test("a client's Ethiopian mobile is stored as +251…, other numbers as typed, and empty contacts become null", async () => {
  allowPermissions(true);
  const create = mock.method(customerAccountService, "createCustomerAccount", async () => customerAccountRow());

  await withServer(app, async (baseUrl) => {
    const local = await call(baseUrl, "POST", clientsPath, {
      token: staffToken(),
      body: { name: "ABC Bank", primary_contact_phone: "0911 22 33 44", primary_contact_email: "" },
    });
    assert.equal(local.status, 201);
    const international = await call(baseUrl, "POST", clientsPath, {
      token: staffToken(),
      body: { name: "Global NGO", primary_contact_phone: "+44 20 7946 0958" },
    });
    assert.equal(international.status, 201);
  });

  const [, first] = create.mock.calls[0]?.arguments ?? [];
  assert.deepEqual([first?.primary_contact_phone, first?.primary_contact_email], ["+251911223344", null]);
  const [, second] = create.mock.calls[1]?.arguments ?? [];
  assert.equal(second?.primary_contact_phone, "+44 20 7946 0958");
});

test("a venue's country is a two-letter code stored upper-case, and its capacity must be positive", async () => {
  allowPermissions(true);
  const create = mock.method(venueService, "createVenue", async () => venueRow());

  await withServer(app, async (baseUrl) => {
    const ok = await call(baseUrl, "POST", venuesPath, { token: staffToken(), body: { name: "Millennium Hall", country: "et", capacity: 2000 } });
    assert.equal(ok.status, 201);

    for (const body of [{ name: "Hall", country: "ETH" }, { name: "Hall", capacity: 0 }]) {
      const refused = await call(baseUrl, "POST", venuesPath, { token: staffToken(), body });
      assert.equal(refused.status, 400, JSON.stringify(body));
    }
  });

  const [, values] = create.mock.calls[0]?.arguments ?? [];
  assert.equal(values?.country, "ET");
  assert.equal(create.mock.callCount(), 1);
});
