import assert from "node:assert/strict";
import { test } from "node:test";
import { eventDisplayStatus, isRegistrationOpen, toPublicEventCard, toPublicEventDetail } from "../src/mappers/event.mapper.js";
import type { PublicEventRow } from "../src/repositories/event.repository.js";
import { eventRow, ticketTypeRow } from "./helpers/fixtures.js";
import { firstFreeSlug, slugify } from "../src/utils/slug.js";
import { canonicalTimeZone } from "../src/utils/time-zone.js";

test("slugify keeps Latin letters and digits; a name in another script gives nothing", () => {
  assert.equal(slugify("Banking Forum 2027!"), "banking-forum-2027");
  assert.equal(slugify("Café Addis"), "cafe-addis");
  assert.equal(slugify("የባንክ ፎረም"), "");
  assert.equal(slugify(`${"a".repeat(9)} b`, 10), "aaaaaaaaa", "cut before trimming, so no trailing hyphen");
});

test("firstFreeSlug picks the base, then -2, -3, …", () => {
  assert.equal(firstFreeSlug("forum", new Set()), "forum");
  assert.equal(firstFreeSlug("forum", new Set(["forum"])), "forum-2");
  assert.equal(firstFreeSlug("forum", new Set(["forum", "forum-2", "forum-4"])), "forum-3");
});

test("time zones are checked against the runtime's IANA database and stored in canonical spelling", () => {
  assert.equal(canonicalTimeZone("Africa/Addis_Ababa"), "Africa/Addis_Ababa");
  assert.equal(canonicalTimeZone("africa/addis_ababa"), "Africa/Addis_Ababa");
  assert.equal(canonicalTimeZone("Mars/Olympus_Mons"), null);
});

test("Live is shown for a published event during its hours; a cancelled one stays Cancelled", () => {
  const event = { starts_at: new Date("2027-03-12T06:00:00Z"), ends_at: new Date("2027-03-12T14:00:00Z") };
  const during = new Date("2027-03-12T10:00:00Z");

  assert.equal(eventDisplayStatus({ ...event, status: "PUBLISHED" }, during), "LIVE");
  assert.equal(eventDisplayStatus({ ...event, status: "PUBLISHED" }, new Date("2027-03-12T14:00:00Z")), "PUBLISHED", "ends_at is exclusive");
  assert.equal(eventDisplayStatus({ ...event, status: "PUBLISHED" }, new Date("2027-03-12T06:00:00Z")), "LIVE", "starts_at is inclusive");
  assert.equal(eventDisplayStatus({ ...event, status: "CANCELLED" }, during), "CANCELLED");
  assert.equal(eventDisplayStatus({ ...event, status: "DRAFT" }, during), "DRAFT");
});

test("registration_open: published, not ended, inside the window (opening inclusive, closing exclusive, unset adds no limit)", () => {
  const opens = new Date("2027-01-01T00:00:00Z");
  const closes = new Date("2027-02-01T00:00:00Z");
  const ends = new Date("2027-03-12T14:00:00Z");
  const event = { status: "PUBLISHED" as const, ends_at: ends, registration_opens_at: opens, registration_closes_at: closes };

  assert.equal(isRegistrationOpen(event, new Date("2026-12-31T23:59:59Z")), false, "before the opening");
  assert.equal(isRegistrationOpen(event, opens), true, "the opening time is inclusive");
  assert.equal(isRegistrationOpen(event, closes), false, "the closing time is exclusive");
  assert.equal(isRegistrationOpen({ ...event, registration_opens_at: null, registration_closes_at: null }, new Date("2027-03-12T13:59:59Z")), true);
  assert.equal(isRegistrationOpen({ ...event, registration_opens_at: null, registration_closes_at: null }, ends), false, "the end time is exclusive");
  assert.equal(isRegistrationOpen({ ...event, status: "CLOSED" }, opens), false, "only PUBLISHED events take sign-ups");
});

test("public shapes carry only visitor fields: no client, staff, internal ids or audit fields", () => {
  const row: PublicEventRow = {
    ...eventRow({ status: "PUBLISHED", visibility: "PUBLIC", customer_account_id: "client-id", description: "Annual forum", category: "Conference" }),
    organization: { name: "Selam Events", slug: "selam-events" },
    venue: { name: "Millennium Hall", address: null, city: "Addis Ababa", country: "ET" },
  };
  const now = new Date("2027-01-15T00:00:00Z");

  const card = toPublicEventCard(row, now);
  assert.deepEqual(Object.keys(card).sort(), [
    "category",
    "cover",
    "display_status",
    "ends_at",
    "name",
    "organization",
    "registration_open",
    "slug",
    "starts_at",
    "timezone",
    "venue",
  ]);
  assert.equal(card.cover, null);

  const detail = toPublicEventDetail(row, [ticketTypeRow(), ticketTypeRow({ code: "VIP", name: "VIP" })], now);
  assert.equal(detail.description, "Annual forum");
  assert.deepEqual(detail.ticket_types, [
    { code: "GA", name: "General Admission" },
    { code: "VIP", name: "VIP" },
  ]);
  const serialized = JSON.stringify(detail);
  for (const secret of ["client-id", "organization_id", "customer_account_id", "created_by", "updated_by", "published_at", '"id"']) {
    assert.ok(!serialized.includes(secret), `${secret} must not reach visitors`);
  }
});
