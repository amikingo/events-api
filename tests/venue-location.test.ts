import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { Transaction } from "sequelize";
import { createApp } from "../src/app.js";
import { NotFoundError } from "../src/errors/app-errors.js";
import type { VenueLocationRow } from "../src/models/venue-location.js";
import { eventRepository, type PublicEventRow } from "../src/repositories/event.repository.js";
import { venueLocationRepository } from "../src/repositories/venue-location.repository.js";
import { venueRepository } from "../src/repositories/venue.repository.js";
import { transactionManager } from "../src/services/helpers.js";
import { permissionResolutionService, type PermissionScope } from "../src/services/permission-resolution.service.js";
import { venueLocationService } from "../src/services/venue-location.service.js";
import { eventRow, IDS, staffToken, venueRow } from "./helpers/fixtures.js";
import { call, withServer } from "./helpers/http.js";

/** Venue map pins against mocked repositories and permissions: no database. */
const FAKE_TX = { id: "fake-transaction" } as unknown as Transaction;
const app = createApp();
const path = `/v1/organizations/${IDS.orgA}/venues/${IDS.venue}/location`;

const pin: VenueLocationRow = {
  id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2",
  organization_id: IDS.orgA,
  venue_id: IDS.venue,
  latitude: 9.0108,
  longitude: 38.7613,
  created_at: new Date(),
  updated_at: new Date(),
  created_by: IDS.user,
  updated_by: IDS.user,
};

function arrange(options: { venue?: boolean; location?: VenueLocationRow | null } = {}) {
  return {
    venue: mock.method(venueRepository, "findByOrganizationAndId", async () => (options.venue === false ? null : venueRow())),
    find: mock.method(venueLocationRepository, "findByVenue", async () => options.location ?? null),
    create: mock.method(venueLocationRepository, "create", async () => pin),
    update: mock.method(venueLocationRepository, "updateByVenue", async () => undefined),
    remove: mock.method(venueLocationRepository, "deleteByVenue", async () => true),
  };
}

beforeEach(() => {
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
});
afterEach(() => mock.restoreAll());

test("saving creates the pin the first time and moves it after, under the venue's lock", async () => {
  const first = arrange();
  assert.deepEqual(await venueLocationService.saveVenueLocation(IDS.orgA, IDS.venue, { latitude: 9, longitude: 38 }, IDS.user), { latitude: 9, longitude: 38 });
  assert.deepEqual(first.venue.mock.calls[0]?.arguments[2], { transaction: FAKE_TX, lock: true });
  assert.deepEqual([first.create.mock.callCount(), first.update.mock.callCount()], [1, 0]);
  mock.restoreAll();

  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
  const again = arrange({ location: pin });
  await venueLocationService.saveVenueLocation(IDS.orgA, IDS.venue, { latitude: 8.5, longitude: 39 }, IDS.user);
  assert.deepEqual([again.create.mock.callCount(), again.update.mock.callCount()], [0, 1]);
});

test("another organization's or an unknown venue is 404 and nothing is written", async () => {
  const calls = arrange({ venue: false });
  await assert.rejects(venueLocationService.saveVenueLocation(IDS.orgB, IDS.venue, { latitude: 9, longitude: 38 }, IDS.user), NotFoundError);
  await assert.rejects(venueLocationService.removeVenueLocation(IDS.orgB, IDS.venue), NotFoundError);
  assert.deepEqual([calls.create.mock.callCount(), calls.remove.mock.callCount()], [0, 0]);
});

test("visitors get a published event's venue pin, null without a venue, and 404 for a draft", async () => {
  arrange({ location: pin });
  mock.method(eventRepository, "findPublishedBySlugs", async () => eventRow({ status: "PUBLISHED", venue_id: IDS.venue }) as PublicEventRow);
  assert.deepEqual(await venueLocationService.getPublicVenueLocation("selam", "forum"), { latitude: 9.0108, longitude: 38.7613 });
  mock.method(eventRepository, "findPublishedBySlugs", async () => eventRow({ status: "PUBLISHED", venue_id: null }) as PublicEventRow);
  assert.equal(await venueLocationService.getPublicVenueLocation("selam", "forum"), null);
  mock.method(eventRepository, "findPublishedBySlugs", async () => null);
  await assert.rejects(venueLocationService.getPublicVenueLocation("selam", "draft"), NotFoundError);
});

test("staff need EVENTS view to read and update to change; bad degrees are refused; visitors need no sign-in", async () => {
  const permission = mock.method(permissionResolutionService, "resolvePermission", async (input: { scope: PermissionScope }) => ({
    allowed: true,
    source: "role_permission" as const,
    scope: input.scope,
    roleIds: [],
  }));
  const save = mock.method(venueLocationService, "saveVenueLocation", async () => ({ latitude: 9, longitude: 38 }));
  mock.method(venueLocationService, "getVenueLocation", async () => null);
  mock.method(venueLocationService, "getPublicVenueLocation", async () => ({ latitude: 9, longitude: 38 }));

  await withServer(app, async (baseUrl) => {
    assert.equal((await call(baseUrl, "GET", path)).status, 401);
    const token = staffToken();
    assert.deepEqual((await call(baseUrl, "GET", path, { token })).body.data, null);
    assert.equal((await call(baseUrl, "PUT", path, { token, body: { latitude: 9, longitude: 38 } })).status, 200);
    assert.equal((await call(baseUrl, "PUT", path, { token, body: { latitude: 91, longitude: 38 } })).status, 400);
    assert.equal((await call(baseUrl, "PUT", path, { token, body: { latitude: 9 } })).status, 400);
    assert.equal((await call(baseUrl, "GET", "/v1/public/organizations/selam/events/forum/venue-location")).status, 200);
  });

  assert.equal(save.mock.callCount(), 1);
  const asked = permission.mock.calls.map((entry) => (entry.arguments[0] as { action: string }).action);
  assert.deepEqual(asked.slice(0, 2), ["view", "update"]);
});
