import assert from "node:assert/strict";
import { test } from "node:test";
import { effectivePrice, windowIssues } from "../src/utils/ticket-pricing.js";

/** Phase 11's one price rule, with Selam's example: GA 500 regular, 700 from 18:00 up to 20:00 (Addis Ababa). */
const at = (time: string) => new Date(`2027-07-01T${time}:00+03:00`);
const EVENING = { id: "w-evening", starts_at: at("18:00"), ends_at: at("20:00"), price: "700.00" };

test("the start is included and the end excluded: 17:59 is 500, exactly 18:00 is 700, 19:59 is 700, exactly 20:00 is 500", () => {
  assert.deepEqual(effectivePrice("500.00", [EVENING], at("17:59")), { price: "500.00", window_id: null, valid_until: at("18:00") });
  assert.deepEqual(effectivePrice("500.00", [EVENING], at("18:00")), { price: "700.00", window_id: "w-evening", valid_until: at("20:00") });
  assert.equal(effectivePrice("500.00", [EVENING], at("19:59")).price, "700.00");
  assert.deepEqual(effectivePrice("500.00", [EVENING], at("20:00")), { price: "500.00", window_id: null, valid_until: null });
});

test("no windows: the regular price, never changing; an open-ended window lasts until the schedule changes", () => {
  assert.deepEqual(effectivePrice("0.00", [], at("12:00")), { price: "0.00", window_id: null, valid_until: null });
  const open = { starts_at: at("18:00"), ends_at: null, price: "650.00" };
  assert.deepEqual(effectivePrice("500.00", [open], at("23:00")), { price: "650.00", window_id: null, valid_until: null });
});

test("adjacent windows hand over at the boundary; the next change is the nearest boundary", () => {
  const late = { id: "w-late", starts_at: at("20:00"), ends_at: at("22:00"), price: "800.00" };
  assert.equal(effectivePrice("500.00", [late, EVENING], at("20:00")).price, "800.00");
  assert.deepEqual(effectivePrice("500.00", [late, EVENING], at("12:00")).valid_until, at("18:00"));
});

test("a schedule's problems: end not after start, overlaps, two open-ended windows; adjacent windows are fine", () => {
  assert.deepEqual(windowIssues([{ starts_at: at("18:00"), ends_at: at("18:00") }]).map((issue) => [issue.index, issue.code]), [[0, "invalid_range"]]);
  assert.deepEqual(windowIssues([EVENING, { starts_at: at("19:00"), ends_at: at("21:00") }]).map((issue) => [issue.index, issue.code]), [[1, "overlapping_window"]]);
  assert.deepEqual(windowIssues([{ starts_at: at("18:00"), ends_at: null }, { starts_at: at("21:00") }]).map((issue) => issue.code), ["overlapping_window"], "two open-ended windows compete");
  assert.deepEqual(windowIssues([{ starts_at: at("20:00"), ends_at: at("22:00") }, EVENING]), [], "adjacent, in any order");
});
