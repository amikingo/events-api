import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { eventRepository, type PublicEventRow } from "../src/repositories/event.repository.js";
import { ticketTypePriceWindowRepository } from "../src/repositories/ticket-type-price-window.repository.js";
import { ticketTypeRepository } from "../src/repositories/ticket-type.repository.js";
import { publicEventService } from "../src/services/public-event.service.js";
import { eventRow, IDS, ticketTypeRow } from "./helpers/fixtures.js";

/** The catalog's prices, against mocked repositories: no database. */
afterEach(() => mock.restoreAll());

const row: PublicEventRow = {
  ...eventRow({ status: "PUBLISHED", visibility: "PUBLIC" }),
  organization: { name: "Selam Events", slug: "selam-events" },
  venue: null,
  coverFile: null,
};

test("each catalog card carries its own event's public ticket types, at the price a new order pays now", async () => {
  mock.method(eventRepository, "listPublicCatalog", async () => ({ rows: [row], count: 1 }));
  const types = mock.method(ticketTypeRepository, "listActivePublicByEvents", async () => [
    ticketTypeRow({ id: "t1", code: "GA", name: "General Admission", price: "500.00" }),
    ticketTypeRow({ id: "t2", code: "VIP", name: "VIP", price: "900.00" }),
    ticketTypeRow({ id: "t3", code: "OTHER", name: "Another event's", price: "1.00", event_id: "ffffffff-ffff-4fff-8fff-fffffffffff1" }),
  ]);
  const windows = mock.method(ticketTypePriceWindowRepository, "listByTicketTypesAcrossEvents", async () => [
    { id: "w1", organization_id: IDS.orgA, event_id: IDS.event, ticket_type_id: "t2", starts_at: new Date("2000-01-01T00:00:00Z"), ends_at: null, price: "750.00", created_at: new Date(), created_by: null },
  ]);

  const { rows, count } = await publicEventService.listCatalog({ page: 1, pageSize: 20 });

  assert.equal(count, 1);
  assert.deepEqual(
    rows[0]?.ticket_types.map((type) => [type.code, type.price, type.is_free]),
    [
      ["GA", "500.00", false],
      ["VIP", "750.00", false],
    ],
  );
  assert.deepEqual([types.mock.callCount(), windows.mock.callCount()], [1, 1], "one query each, however many events");
});
