import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { createApp } from "../src/app.js";
import { toEventDto } from "../src/mappers/event.mapper.js";
import { eventService } from "../src/services/event.service.js";
import { organizationService } from "../src/services/organization.service.js";
import { permissionResolutionService, type PermissionScope } from "../src/services/permission-resolution.service.js";
import { eventRow, IDS, organizationRow, staffToken } from "./helpers/fixtures.js";
import { call, withServer } from "./helpers/http.js";

/**
 * HTTP-level tests of the event, ticket type and organization-settings routes: real auth, validation and envelope;
 * the permission engine and the services are stubbed.
 */
const app = createApp();
const eventsPath = `/v1/organizations/${IDS.orgA}/events`;

function allowPermissions(allowed: boolean) {
  return mock.method(permissionResolutionService, "resolvePermission", async (input: { scope: PermissionScope }) => ({
    allowed,
    source: allowed ? ("role_permission" as const) : ("default_deny" as const),
    scope: input.scope,
    roleIds: [],
  }));
}

afterEach(() => mock.restoreAll());

test("events and ticket types use the EVENTS module; organization defaults use ORGANIZATIONS update", async () => {
  const permission = allowPermissions(false);

  await withServer(app, async (baseUrl) => {
    const token = staffToken();
    await call(baseUrl, "POST", eventsPath, { token, body: { name: "Forum" } });
    await call(baseUrl, "PATCH", `${eventsPath}/${IDS.event}/status`, { token, body: { status: "PUBLISHED" } });
    await call(baseUrl, "POST", `${eventsPath}/${IDS.event}/ticket-types`, { token, body: { code: "VIP", name: "VIP" } });
    await call(baseUrl, "GET", `${eventsPath}/${IDS.event}/ticket-types`, { token });
    await call(baseUrl, "PATCH", `/v1/organizations/${IDS.orgA}`, { token, body: { timezone: "Europe/London" } });
  });

  const requested = permission.mock.calls.map((entry) => entry.arguments[0] as { moduleCode: string; action: string; scope: PermissionScope });
  assert.deepEqual(
    requested.map((input) => [input.moduleCode, input.action]),
    [
      ["EVENTS", "create"],
      ["EVENTS", "update"],
      ["EVENTS", "update"],
      ["EVENTS", "view"],
      ["ORGANIZATIONS", "update"],
    ],
  );
  for (const input of requested) assert.deepEqual(input.scope, { level: "organization", organizationId: IDS.orgA, branchId: null });
});

test("event input: an IANA time zone, instants with an offset, end after start, and no return to DRAFT", async () => {
  allowPermissions(true);
  const create = mock.method(eventService, "createEvent", async () => toEventDto(eventRow()));
  const changeStatus = mock.method(eventService, "changeEventStatus", async () => toEventDto(eventRow()));

  await withServer(app, async (baseUrl) => {
    const token = staffToken();
    const refused = [
      { name: "Forum", timezone: "Mars/Olympus_Mons" },
      { name: "Forum", starts_at: "2027-03-12T09:00:00" }, // no offset: ambiguous
      { name: "Forum", starts_at: "2027-03-12T17:00:00+03:00", ends_at: "2027-03-12T09:00:00+03:00" },
      { name: "Forum", visibility: "PRIVATE" },
    ];
    for (const body of refused) {
      const response = await call(baseUrl, "POST", eventsPath, { token, body });
      assert.equal(response.status, 400, JSON.stringify(body));
    }

    const ok = await call(baseUrl, "POST", eventsPath, {
      token,
      body: { name: "Forum", timezone: "africa/addis_ababa", starts_at: "2027-03-12T09:00:00+03:00", ends_at: "2027-03-12T17:00:00+03:00" },
    });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.data.display_status, "DRAFT");

    const toDraft = await call(baseUrl, "PATCH", `${eventsPath}/${IDS.event}/status`, { token, body: { status: "DRAFT" } });
    assert.equal(toDraft.status, 400);
  });

  assert.equal(create.mock.callCount(), 1);
  const [, input] = create.mock.calls[0]?.arguments ?? [];
  assert.equal(input?.timezone, "Africa/Addis_Ababa", "stored in canonical spelling");
  assert.deepEqual(input?.starts_at, new Date("2027-03-12T06:00:00Z"));
  assert.equal(changeStatus.mock.callCount(), 0);
});

test("organization defaults: codes are normalized and checked", async () => {
  allowPermissions(true);
  const update = mock.method(organizationService, "updateOrganizationSettings", async () => organizationRow());

  await withServer(app, async (baseUrl) => {
    const token = staffToken();
    assert.equal((await call(baseUrl, "PATCH", `/v1/organizations/${IDS.orgA}`, { token, body: { default_currency: "BIRR" } })).status, 400);
    assert.equal((await call(baseUrl, "PATCH", `/v1/organizations/${IDS.orgA}`, { token, body: {} })).status, 400);
    const ok = await call(baseUrl, "PATCH", `/v1/organizations/${IDS.orgA}`, { token, body: { country: "ke", default_currency: "kes" } });
    assert.equal(ok.status, 200);
  });

  const [, input] = update.mock.calls[0]?.arguments ?? [];
  assert.deepEqual([input?.country, input?.default_currency], ["KE", "KES"]);
});
