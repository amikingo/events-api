import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, mock, test } from "node:test";
import { createApp } from "../src/app.js";
import { filesConfig } from "../src/config/files.js";
import { toEventDto } from "../src/mappers/event.mapper.js";
import { eventCoverService } from "../src/services/event-cover.service.js";
import { permissionResolutionService, type PermissionScope } from "../src/services/permission-resolution.service.js";
import { eventRow, IDS, staffToken } from "./helpers/fixtures.js";
import { withServer, type TestResponse } from "./helpers/http.js";

/**
 * HTTP-level tests of the cover upload: real auth, validation, multer limits, envelope and static serving; the
 * permission engine and the cover service are stubbed.
 */
const app = createApp();
const coverPath = `/v1/organizations/${IDS.orgA}/events/${IDS.event}/cover`;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png body")]);
const MAX = filesConfig.coverMaxBytes;

function allowPermissions(allowed: boolean) {
  return mock.method(permissionResolutionService, "resolvePermission", async (input: { scope: PermissionScope }) => ({
    allowed,
    source: allowed ? ("role_permission" as const) : ("default_deny" as const),
    scope: input.scope,
    roleIds: [],
  }));
}

function stubService() {
  const dto = toEventDto(eventRow({ cover_file_id: IDS.file }), new Date(), { url: "/assets/uploads/events/covers/new.png" });
  return {
    set: mock.method(eventCoverService, "setEventCover", async () => dto),
    remove: mock.method(eventCoverService, "removeEventCover", async () => toEventDto(eventRow())),
  };
}

function imageForm(bytes: Buffer, field = "file"): FormData {
  const form = new FormData();
  form.append(field, new Blob([new Uint8Array(bytes)], { type: "image/png" }), "Summit poster.png");
  return form;
}

async function send(
  baseUrl: string,
  method: string,
  path: string,
  options: { token?: string; form?: FormData; json?: unknown; headers?: Record<string, string>; rawBody?: string } = {},
): Promise<TestResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.json === undefined ? {} : { "Content-Type": "application/json" }),
      ...options.headers,
    },
    body: options.form ?? options.rawBody ?? (options.json === undefined ? null : JSON.stringify(options.json)),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}

afterEach(() => mock.restoreAll());

test("covers need EVENTS update; without a token or permission the upload is refused before its body is read", async () => {
  const permission = allowPermissions(false);
  const service = stubService();
  const oversized = Buffer.alloc(MAX + 1024, 1); // would be 413 if the body were parsed

  await withServer(app, async (baseUrl) => {
    assert.equal((await send(baseUrl, "PUT", coverPath, { form: imageForm(oversized) })).status, 401);
    const token = staffToken();
    const denied = await send(baseUrl, "PUT", coverPath, { token, form: imageForm(oversized) });
    assert.deepEqual([denied.status, denied.body.error.code], [403, "permission_denied"]);
    assert.equal((await send(baseUrl, "DELETE", coverPath, { token })).status, 403);
  });

  const requested = permission.mock.calls.map((entry) => entry.arguments[0] as { moduleCode: string; action: string; scope: PermissionScope });
  assert.deepEqual(
    requested.map((input) => [input.moduleCode, input.action]),
    [
      ["EVENTS", "update"],
      ["EVENTS", "update"],
    ],
  );
  for (const input of requested) assert.deepEqual(input.scope, { level: "organization", organizationId: IDS.orgA, branchId: null });
  assert.deepEqual([service.set.mock.callCount(), service.remove.mock.callCount()], [0, 0]);
});

test("an upload passes the image bytes, its original name and the actor to the service; DELETE detaches", async () => {
  allowPermissions(true);
  const service = stubService();

  await withServer(app, async (baseUrl) => {
    const token = staffToken();
    const uploaded = await send(baseUrl, "PUT", coverPath, { token, form: imageForm(PNG) });
    assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
    assert.deepEqual(uploaded.body.data.cover, { url: "/assets/uploads/events/covers/new.png" });

    const removed = await send(baseUrl, "DELETE", coverPath, { token });
    assert.deepEqual([removed.status, removed.body.data.cover], [200, null]);

    assert.equal((await send(baseUrl, "PUT", `/v1/organizations/${IDS.orgA}/events/not-a-uuid/cover`, { token, form: imageForm(PNG) })).status, 400);
  });

  const [organizationId, eventId, upload, actorId] = service.set.mock.calls[0]?.arguments ?? [];
  assert.deepEqual([organizationId, eventId, actorId], [IDS.orgA, IDS.event, IDS.user]);
  assert.deepEqual(upload, { bytes: PNG, originalName: "Summit poster.png" });
  assert.deepEqual(service.remove.mock.calls[0]?.arguments, [IDS.orgA, IDS.event, IDS.user]);
  assert.equal(service.set.mock.callCount(), 1, "the invalid event id never reached the service");
});

test("5 MB is accepted; one byte more is 413 payload_too_large", async () => {
  allowPermissions(true);
  const service = stubService();

  await withServer(app, async (baseUrl) => {
    const token = staffToken();
    assert.equal((await send(baseUrl, "PUT", coverPath, { token, form: imageForm(Buffer.alloc(MAX, 1)) })).status, 200);
    const tooLarge = await send(baseUrl, "PUT", coverPath, { token, form: imageForm(Buffer.alloc(MAX + 1, 1)) });
    assert.deepEqual([tooLarge.status, tooLarge.body.error.code], [413, "payload_too_large"]);
  });

  assert.equal(service.set.mock.callCount(), 1);
});

test("exactly one file in the field 'file' and nothing else: extra fields, extra files, a wrong field, no file or a broken body are 400", async () => {
  allowPermissions(true);
  const service = stubService();

  await withServer(app, async (baseUrl) => {
    const token = staffToken();

    const withField = imageForm(PNG);
    withField.append("name", "extra");
    const fieldFirst = new FormData();
    fieldFirst.append("name", "extra");
    fieldFirst.append("file", new Blob([new Uint8Array(PNG)], { type: "image/png" }), "a.png");
    const twoFiles = imageForm(PNG);
    twoFiles.append("file", new Blob([new Uint8Array(PNG)], { type: "image/png" }), "b.png");

    const cases: Array<[string, Parameters<typeof send>[3]]> = [
      ["an extra field after the file", { token, form: withField }],
      ["an extra field before the file", { token, form: fieldFirst }],
      ["two files", { token, form: twoFiles }],
      ["the file in another field", { token, form: imageForm(PNG, "image") }],
      ["an empty form", { token, form: new FormData() }],
      ["a JSON body", { token, json: { file: "data:image/png;base64,AAAA" } }],
      ["multipart without a boundary", { token, headers: { "Content-Type": "multipart/form-data" }, rawBody: "--x\r\n" }],
    ];
    for (const [label, options] of cases) {
      const response = await send(baseUrl, "PUT", coverPath, options);
      assert.deepEqual([response.status, response.body?.error?.code], [400, "validation_error"], `${label}: ${JSON.stringify(response.body)}`);
    }
  });

  assert.equal(service.set.mock.callCount(), 0);
});

test("stored files are served publicly under /assets/uploads with CORP cross-origin and a long cache; nothing else is", async () => {
  const name = `${randomUUID()}.png`;
  const folder = join(filesConfig.rootDir, "events", "covers");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, name), PNG);
  writeFileSync(join(folder, ".hidden"), "secret");

  await withServer(app, async (baseUrl) => {
    const served = await fetch(`${baseUrl}/assets/uploads/events/covers/${name}`);
    assert.equal(served.status, 200);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);
    assert.equal(served.headers.get("content-type"), "image/png");
    assert.equal(served.headers.get("cross-origin-resource-policy"), "cross-origin");
    assert.equal(served.headers.get("x-content-type-options"), "nosniff");
    assert.match(served.headers.get("cache-control") ?? "", /max-age=31536000.*immutable/);

    for (const path of ["/assets/uploads/events/covers/missing.png", "/assets/uploads/events/covers/.hidden", "/assets/uploads/events/covers", "/assets/uploads/events/covers/"]) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 404, path);
      assert.equal(((await response.json()) as { error: { code: string } }).error.code, "route_not_found", path);
    }
  });
});
