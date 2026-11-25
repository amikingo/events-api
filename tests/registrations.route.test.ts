import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { createApp } from "../src/app.js";
import { CapacityReachedError } from "../src/errors/app-errors.js";
import { toRegistrationDto } from "../src/mappers/registration.mapper.js";
import { permissionResolutionService, type PermissionScope } from "../src/services/permission-resolution.service.js";
import { personService } from "../src/services/person.service.js";
import { registrationService } from "../src/services/registration.service.js";
import { IDS, personRow, registrationRow, staffToken, ticketTypeRow } from "./helpers/fixtures.js";
import { call, withServer } from "./helpers/http.js";

/**
 * HTTP-level tests of the guest-profile and registration routes: real auth, validation and envelope; the permission
 * engine and the services are stubbed.
 */
const app = createApp();
const personsPath = `/v1/organizations/${IDS.orgA}/persons`;
const registrationsPath = `/v1/organizations/${IDS.orgA}/events/${IDS.event}/registrations`;
const dto = toRegistrationDto({ ...registrationRow(), person: personRow(), ticketType: ticketTypeRow() });

function allowPermissions(allowed: boolean) {
  return mock.method(permissionResolutionService, "resolvePermission", async (input: { scope: PermissionScope }) => ({
    allowed,
    source: allowed ? ("role_permission" as const) : ("default_deny" as const),
    scope: input.scope,
    roleIds: [],
  }));
}

afterEach(() => mock.restoreAll());

test("guest profiles and registrations use the REGISTRATIONS module, scoped to the path's organization", async () => {
  const permission = allowPermissions(false);

  await withServer(app, async (baseUrl) => {
    const token = staffToken();
    assert.equal((await call(baseUrl, "POST", registrationsPath)).status, 401, "no token");
    await call(baseUrl, "POST", personsPath, { token, body: { first_name: "Hana" } });
    await call(baseUrl, "GET", personsPath, { token });
    await call(baseUrl, "PATCH", `${personsPath}/${IDS.person}/status`, { token, body: { is_active: false } });
    await call(baseUrl, "POST", registrationsPath, { token, body: { person_id: IDS.person } });
    await call(baseUrl, "GET", registrationsPath, { token });
    await call(baseUrl, "GET", `${registrationsPath}/summary`, { token });
    const denied = await call(baseUrl, "PATCH", `${registrationsPath}/${IDS.registration}/status`, { token, body: { status: "CANCELLED" } });
    assert.deepEqual([denied.status, denied.body.error.code], [403, "permission_denied"]);
  });

  const requested = permission.mock.calls.map((entry) => entry.arguments[0] as { moduleCode: string; action: string; scope: PermissionScope });
  assert.deepEqual(
    requested.map((input) => [input.moduleCode, input.action]),
    [
      ["REGISTRATIONS", "create"],
      ["REGISTRATIONS", "view"],
      ["REGISTRATIONS", "update"],
      ["REGISTRATIONS", "create"],
      ["REGISTRATIONS", "view"],
      ["REGISTRATIONS", "view"],
      ["REGISTRATIONS", "update"],
    ],
  );
  for (const input of requested) assert.deepEqual(input.scope, { level: "organization", organizationId: IDS.orgA, branchId: null });
});

test("a registration names an existing guest or a new one, never both; phones are normalized; nothing invalid reaches the service", async () => {
  allowPermissions(true);
  const register = mock.method(
    registrationService,
    "registerGuest",
    async (_organizationId: string, _eventId: string, _input: unknown, _actorId: string | null) => ({ registration: dto, outcome: "CREATED" as const }),
  );

  await withServer(app, async (baseUrl) => {
    const token = staffToken();
    const refused = [
      {},
      { person_id: IDS.person, person: { first_name: "Hana" } },
      { person: { last_name: "Bekele" } },
      { person: { first_name: "Hana", pin: "1234" } },
      { person_id: "not-a-uuid" },
      { person_id: IDS.person, source: "PUBLIC" },
    ];
    for (const body of refused) {
      const response = await call(baseUrl, "POST", registrationsPath, { token, body });
      assert.equal(response.status, 400, JSON.stringify(body));
    }

    const created = await call(baseUrl, "POST", registrationsPath, { token, body: { person: { first_name: "Hana", phone: "0911 234 567" } } });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.code, "K7M2Q9XP");
  });

  assert.equal(register.mock.callCount(), 1);
  const [organizationId, eventId, input, actorId] = register.mock.calls[0]?.arguments ?? [];
  assert.deepEqual([organizationId, eventId, actorId], [IDS.orgA, IDS.event, IDS.user]);
  assert.equal((input as { person: { phone: string } }).person.phone, "+251911234567");
});

test("a repeat answers 200, a reactivation 201; capacity and closed errors keep their codes", async () => {
  allowPermissions(true);
  const outcomes = ["UNCHANGED", "REACTIVATED"] as const;
  let index = 0;
  mock.method(registrationService, "registerGuest", async () => ({ registration: dto, outcome: outcomes[index++] ?? "CREATED" }));

  await withServer(app, async (baseUrl) => {
    const token = staffToken();
    const repeat = await call(baseUrl, "POST", registrationsPath, { token, body: { person_id: IDS.person } });
    assert.deepEqual([repeat.status, repeat.body.message], [200, "Guest is already registered"]);
    const reactivated = await call(baseUrl, "POST", registrationsPath, { token, body: { person_id: IDS.person } });
    assert.deepEqual([reactivated.status, reactivated.body.message], [201, "Registration reactivated"]);

    mock.method(registrationService, "registerGuest", async () => {
      throw new CapacityReachedError("This event is full", { scope: "EVENT", capacity: 1 });
    });
    const full = await call(baseUrl, "POST", registrationsPath, { token, body: { person_id: IDS.person } });
    assert.deepEqual([full.status, full.body.error.code, full.body.error.details.scope], [409, "capacity_reached", "EVENT"]);
  });
});

test("the guest list passes its filters through; only CANCELLED or CONFIRMED are accepted as a status change", async () => {
  allowPermissions(true);
  const list = mock.method(registrationService, "listRegistrations", async (_organizationId: string, _eventId: string, _query: unknown) => ({
    rows: [dto],
    count: 1,
  }));
  const change = mock.method(registrationService, "changeRegistrationStatus", async () => dto);
  mock.method(personService, "getPerson", async () => ({ ...personRow(), registrations: [] }));

  await withServer(app, async (baseUrl) => {
    const token = staffToken();
    const response = await call(baseUrl, "GET", `${registrationsPath}?status=CONFIRMED&q=Hana&page=2&pageSize=5`, { token });
    assert.deepEqual([response.status, response.body.meta.count, response.body.data[0].person.first_name], [200, 1, "Hana"]);
    assert.equal((await call(baseUrl, "GET", `${registrationsPath}?status=WAITLIST`, { token })).status, 400);

    assert.equal((await call(baseUrl, "PATCH", `${registrationsPath}/${IDS.registration}/status`, { token, body: { status: "DELETED" } })).status, 400);
    assert.equal((await call(baseUrl, "PATCH", `${registrationsPath}/${IDS.registration}/status`, { token, body: { status: "CANCELLED" } })).status, 200);

    assert.equal((await call(baseUrl, "GET", `${personsPath}/${IDS.person}`, { token })).status, 200);
  });

  const [, , query] = list.mock.calls[0]?.arguments ?? [];
  const passed = query as { status: string; q: string; page: number; pageSize: number };
  assert.deepEqual([passed.status, passed.q, passed.page, passed.pageSize], ["CONFIRMED", "Hana", 2, 5]);
  assert.deepEqual(change.mock.calls[0]?.arguments, [IDS.orgA, IDS.event, IDS.registration, "CANCELLED", IDS.user]);
});

test("staff may send an Idempotency-Key: it reaches the service, a malformed one is 400, and a replay answers 200", async () => {
  allowPermissions(true);
  const register = mock.method(
    registrationService,
    "registerGuest",
    async (_organizationId: string, _eventId: string, _input: unknown, _actorId: string | null, _key?: string) => ({
      registration: dto,
      outcome: "REPLAYED" as const,
    }),
  );

  await withServer(app, async (baseUrl) => {
    const send = (key: string) =>
      fetch(`${baseUrl}${registrationsPath}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${staffToken()}`, "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({ person_id: IDS.person }),
      });

    const malformed = await send("no");
    assert.equal(malformed.status, 400);
    assert.equal(((await malformed.json()) as any).error.details.issues[0].path, "headers.idempotency-key");

    const replayed = await send("staff-key-0001");
    assert.equal(replayed.status, 200);
    assert.equal(((await replayed.json()) as any).message, "Same request already processed");
  });

  assert.equal(register.mock.callCount(), 1);
  assert.equal(register.mock.calls[0]?.arguments[4], "staff-key-0001");
});

// --- Phase 4d: changing a ticket type and exporting -------------------------------------------

test("the export needs REGISTRATIONS export and a ticket type change REGISTRATIONS update, in the path's organization; 'export' is never read as an id", async () => {
  const permission = allowPermissions(false);
  const getOne = mock.method(registrationService, "getRegistration", async () => dto);

  await withServer(app, async (baseUrl) => {
    const token = staffToken();
    assert.equal((await call(baseUrl, "GET", `${registrationsPath}/export`)).status, 401, "no token");
    const denied = await call(baseUrl, "GET", `${registrationsPath}/export`, { token });
    assert.deepEqual([denied.status, denied.body.error.code], [403, "permission_denied"]);
    const moveDenied = await call(baseUrl, "PATCH", `${registrationsPath}/${IDS.registration}/ticket-type`, { token, body: { ticket_type_id: IDS.ticketType } });
    assert.equal(moveDenied.status, 403);
  });

  const requested = permission.mock.calls.map((entry) => entry.arguments[0] as { moduleCode: string; action: string; scope: PermissionScope });
  assert.deepEqual(
    requested.map((input) => [input.moduleCode, input.action]),
    [
      ["REGISTRATIONS", "export"],
      ["REGISTRATIONS", "update"],
    ],
  );
  for (const input of requested) assert.deepEqual(input.scope, { level: "organization", organizationId: IDS.orgA, branchId: null });
  assert.equal(getOne.mock.callCount(), 0);
});

test("the export answers a CSV attachment named by the service, passes the filters, and refuses paging", async () => {
  allowPermissions(true);
  const exportCsv = mock.method(registrationService, "exportRegistrations", async (_organizationId: string, _eventId: string, _query: unknown) => ({
    filename: "banking-forum-guests.csv",
    csv: "\uFEFFCode\r\n",
  }));

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}${registrationsPath}/export?status=CONFIRMED&q=Hana`, { headers: { Authorization: `Bearer ${staffToken()}` } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
    assert.equal(response.headers.get("content-disposition"), 'attachment; filename="banking-forum-guests.csv"');
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 3).toString("hex"), "efbbbf", "the byte-order mark reaches the client");

    const paged = await call(baseUrl, "GET", `${registrationsPath}/export?page=2`, { token: staffToken() });
    assert.deepEqual([paged.status, paged.body.error.code], [400, "validation_error"]);
  });

  assert.equal(exportCsv.mock.callCount(), 1);
  const [organizationId, eventId, query] = exportCsv.mock.calls[0]?.arguments ?? [];
  assert.deepEqual([organizationId, eventId, query], [IDS.orgA, IDS.event, { status: "CONFIRMED", q: "Hana" }]);
});

test("a ticket type change takes one ticket_type_id and says whether anything changed", async () => {
  allowPermissions(true);
  const results = [true, false];
  let index = 0;
  const move = mock.method(
    registrationService,
    "changeRegistrationTicketType",
    async (_o: string, _e: string, _r: string, _t: string, _a: string | null) => ({ registration: dto, changed: results[index++] ?? false }),
  );
  const path = `${registrationsPath}/${IDS.registration}/ticket-type`;

  await withServer(app, async (baseUrl) => {
    const token = staffToken();
    for (const body of [{}, { ticket_type_id: "not-a-uuid" }, { ticket_type_id: IDS.ticketType, status: "CONFIRMED" }]) {
      assert.equal((await call(baseUrl, "PATCH", path, { token, body })).status, 400, JSON.stringify(body));
    }
    const changed = await call(baseUrl, "PATCH", path, { token, body: { ticket_type_id: IDS.ticketType } });
    assert.deepEqual([changed.status, changed.body.message], [200, "Ticket type changed"]);
    const unchanged = await call(baseUrl, "PATCH", path, { token, body: { ticket_type_id: IDS.ticketType } });
    assert.deepEqual([unchanged.status, unchanged.body.message], [200, "Ticket type unchanged"]);
  });

  assert.deepEqual(move.mock.calls[0]?.arguments, [IDS.orgA, IDS.event, IDS.registration, IDS.ticketType, IDS.user]);
});
