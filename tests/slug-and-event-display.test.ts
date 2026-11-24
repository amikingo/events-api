import assert from "node:assert/strict";
import { test } from "node:test";
import { eventDisplayStatus } from "../src/mappers/event.mapper.js";
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
