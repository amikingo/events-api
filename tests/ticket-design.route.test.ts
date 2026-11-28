import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { createApp } from "../src/app.js";
import { toTicketDesignDto } from "../src/mappers/ticket-design.mapper.js";
import { permissionResolutionService, type PermissionScope } from "../src/services/permission-resolution.service.js";
import { ticketDesignService } from "../src/services/ticket-design.service.js";
import { IDS, staffToken, ticketDesignRow } from "./helpers/fixtures.js";
import { call, withServer } from "./helpers/http.js";

/** HTTP-level tests of the ticket design endpoints: real auth, validation and envelope; permissions and service stubbed. */
const app = createApp();
const path = `/v1/organizations/${IDS.orgA}/events/${IDS.event}/ticket-design`;
const publicPath = "/v1/public/organizations/selam/events/banking-forum/ticket-design";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png body")]);

function allowPermissions(allowed: boolean) {
  return mock.method(permissionResolutionService, "resolvePermission", async (input: { scope: PermissionScope }) => ({
    allowed,
    source: allowed ? ("role_permission" as const) : ("default_deny" as const),
    scope: input.scope,
    roleIds: [],
  }));
}

function stubService() {
  const dto = toTicketDesignDto(ticketDesignRow(), new Map());
  return {
    get: mock.method(ticketDesignService, "getTicketDesign", async () => null),
    getPublic: mock.method(ticketDesignService, "getPublicTicketDesign", async () => dto),
    save: mock.method(ticketDesignService, "saveTicketDesign", async () => dto),
    remove: mock.method(ticketDesignService, "removeTicketDesign", async () => null),
    setImage: mock.method(ticketDesignService, "setTicketImage", async () => dto),
    removeImage: mock.method(ticketDesignService, "removeTicketImage", async () => dto),
  };
}

function imageForm(bytes: Buffer): FormData {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "image/png" }), "logo.png");
  return form;
}

async function upload(baseUrl: string, target: string, token: string | null, form: FormData) {
  const response = await fetch(`${baseUrl}${target}`, { method: "PUT", headers: token ? { Authorization: `Bearer ${token}` } : {}, body: form });
  return { status: response.status, body: await response.json() };
}

afterEach(() => mock.restoreAll());

test("reading needs EVENTS view, every change EVENTS update; nothing reaches the service without them", async () => {
  const permission = allowPermissions(false);
  const service = stubService();

  await withServer(app, async (baseUrl) => {
    assert.equal((await call(baseUrl, "GET", path)).status, 401);
    assert.equal((await upload(baseUrl, `${path}/images/logo`, null, imageForm(PNG))).status, 401);
    const token = staffToken();
    for (const [method, target, body] of [
      ["GET", path, undefined],
      ["PUT", path, { design: "gold" }],
      ["DELETE", path, undefined],
      ["DELETE", `${path}/images/logo`, undefined],
    ] as const) {
      assert.equal((await call(baseUrl, method, target, { token, body })).status, 403, `${method} ${target}`);
    }
    assert.equal((await upload(baseUrl, `${path}/images/logo`, token, imageForm(PNG))).status, 403);
  });

  const requested = permission.mock.calls.map((entry) => entry.arguments[0] as { moduleCode: string; action: string });
  assert.deepEqual(
    requested.map((input) => [input.moduleCode, input.action]),
    [
      ["EVENTS", "view"],
      ["EVENTS", "update"],
      ["EVENTS", "update"],
      ["EVENTS", "update"],
      ["EVENTS", "update"],
    ],
  );
  for (const method of Object.values(service)) assert.equal(method.mock.callCount(), 0);
});

test("the settings, the picture and the actor reach the service; bad input is refused", async () => {
  allowPermissions(true);
  const service = stubService();

  await withServer(app, async (baseUrl) => {
    const token = staffToken();
    const read = await call(baseUrl, "GET", path, { token });
    assert.deepEqual([read.status, read.body.data], [200, null]);
    assert.equal((await call(baseUrl, "PUT", path, { token, body: { design: "gold", color: "blue" } })).status, 200);
    assert.equal((await upload(baseUrl, `${path}/images/artwork`, token, imageForm(PNG))).status, 200);
    assert.equal((await call(baseUrl, "DELETE", `${path}/images/picture`, { token })).status, 200);

    assert.equal((await call(baseUrl, "PUT", path, { token, body: { design: "gold", extra: true } })).status, 400);
    assert.equal((await upload(baseUrl, `${path}/images/banner`, token, imageForm(PNG))).status, 400);
    assert.equal((await upload(baseUrl, `${path}/images/logo`, token, new FormData())).status, 400);
  });

  assert.deepEqual([service.save.mock.callCount(), service.setImage.mock.callCount()], [1, 1]);
  const [organizationId, eventId, settings, actorId] = service.save.mock.calls[0]?.arguments ?? [];
  assert.deepEqual([organizationId, eventId, settings?.design, settings?.color, actorId], [IDS.orgA, IDS.event, "gold", "blue", IDS.user]);
  assert.deepEqual(service.setImage.mock.calls[0]?.arguments, [IDS.orgA, IDS.event, "artwork", { bytes: PNG, originalName: "logo.png" }, IDS.user]);
});

test("buyers read a design without signing in", async () => {
  const service = stubService();
  await withServer(app, async (baseUrl) => {
    const response = await call(baseUrl, "GET", publicPath);
    assert.deepEqual([response.status, response.body.data.design], [200, "gold"]);
  });
  assert.deepEqual(service.getPublic.mock.calls[0]?.arguments, ["selam", "banking-forum"]);
});
