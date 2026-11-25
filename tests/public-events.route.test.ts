import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { createApp } from "../src/app.js";
import { NotFoundError } from "../src/errors/app-errors.js";
import { publicEventService } from "../src/services/public-event.service.js";
import { call, withServer } from "./helpers/http.js";

/** HTTP-level tests of the public routes: no login, real validation and envelope; the service is stubbed. */
const app = createApp();

afterEach(() => mock.restoreAll());

test("the catalog needs no login and passes the filters through", async () => {
  const list = mock.method(publicEventService, "listCatalog", async () => ({ rows: [], count: 0 }));

  await withServer(app, async (baseUrl) => {
    const response = await call(baseUrl, "GET", "/v1/public/events?category=Conference&organization=selam-events&page=2&pageSize=5");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.meta, { count: 0, page: 2, pageSize: 5 });
  });

  const [query] = list.mock.calls[0]?.arguments ?? [];
  assert.deepEqual([query?.category, query?.organization, query?.page, query?.pageSize], ["Conference", "selam-events", 2, 5]);
});

test("an event page needs no login; a malformed slug is 400 and an unknown event 404", async () => {
  mock.method(publicEventService, "getPublicEvent", async () => {
    throw new NotFoundError("Event not found");
  });

  await withServer(app, async (baseUrl) => {
    assert.equal((await call(baseUrl, "GET", "/v1/public/organizations/selam-events/events/Not_A_Slug")).status, 400);
    const missing = await call(baseUrl, "GET", "/v1/public/organizations/selam-events/events/banking-forum");
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, "not_found");
  });
});
