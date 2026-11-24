import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { Transaction } from "sequelize";
import { NotFoundError } from "../src/errors/app-errors.js";
import { organizationRepository } from "../src/repositories/organization.repository.js";
import { venueRepository } from "../src/repositories/venue.repository.js";
import { transactionManager } from "../src/services/helpers.js";
import { venueService } from "../src/services/venue.service.js";
import { IDS, organizationRow, venueRow } from "./helpers/fixtures.js";

/** The venue service against mocked repositories and a fake transaction: no database needed. */
const FAKE_TX = { id: "fake-transaction" } as unknown as Transaction;

beforeEach(() => {
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
  mock.method(organizationRepository, "findById", async () => organizationRow());
});
afterEach(() => mock.restoreAll());

test("a new venue keeps only the fields given, scoped to the organization and the transaction", async () => {
  const create = mock.method(venueRepository, "create", async () => venueRow());

  // Validated input always carries the transformed optional keys; undefined means "not sent".
  await venueService.createVenue(
    IDS.orgA,
    { name: "Millennium Hall", address: undefined, city: "Addis Ababa", country: undefined, capacity: 2000 },
    IDS.user,
  );

  const [values, options] = create.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(
    [values?.organization_id, values?.name, values?.address, values?.city, values?.country, values?.capacity, values?.is_active],
    [IDS.orgA, "Millennium Hall", null, "Addis Ababa", null, 2000, true],
  );
  assert.deepEqual(options, { transaction: FAKE_TX });
});

test("an update persists only allow-listed fields with PATCH semantics; null clears the capacity", async () => {
  mock.method(venueRepository, "findByOrganizationAndId", async () => venueRow());
  const update = mock.method(venueRepository, "updateByOrganizationAndId", async () => venueRow({ capacity: null }));

  await venueService.updateVenue(IDS.orgA, IDS.venue, { capacity: null, city: "Adama", address: undefined, country: undefined }, IDS.user);

  const [organizationId, venueId, values, options] = update.mock.calls[0]?.arguments ?? [];
  assert.deepEqual([organizationId, venueId], [IDS.orgA, IDS.venue]);
  assert.deepEqual(values, { city: "Adama", capacity: null, updated_by: IDS.user });
  assert.deepEqual(options, { transaction: FAKE_TX });
});

test("a venue of another organization is not found: the id alone is never a tenant boundary", async () => {
  mock.method(venueRepository, "findByOrganizationAndId", async () => null);
  const update = mock.method(venueRepository, "updateByOrganizationAndId", async () => venueRow());

  await assert.rejects(venueService.changeVenueStatus(IDS.orgB, IDS.venue, false, IDS.user), NotFoundError);
  assert.equal(update.mock.callCount(), 0);
});
