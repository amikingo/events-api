import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmationText } from "../src/utils/confirmation-message.js";
import { ethiopianClockText, ethiopianDateText, gregorianToJDN, jdnToEthiopian, jdnToGregorian } from "../src/utils/ethiopian-calendar.js";

/** The Ethiopian calendar and clock, and the confirmation SMS text (Ethiopian first, then Gregorian 12-hour). */
const PAYLOAD = {
  first_name: "Hana",
  organization_name: "Selam Events",
  event_name: "Banking Forum",
  starts_at: "2027-03-12T06:00:00.000Z",
  timezone: "Africa/Addis_Ababa",
  code: "K7M2Q9XP",
};

test("the Ethiopian calendar matches known dates, including Pagume 6 of a leap year", () => {
  assert.equal(ethiopianDateText({ year: 2026, month: 9, day: 11 }), "Meskerem 1, 2019", "Ethiopian new year 2019");
  assert.equal(ethiopianDateText({ year: 2027, month: 3, day: 12 }), "Megabit 3, 2019");
  assert.equal(ethiopianDateText({ year: 2027, month: 9, day: 11 }), "Pagume 6, 2019", "2019 is a leap year: Pagume has 6 days");
  assert.equal(ethiopianDateText({ year: 2027, month: 9, day: 12 }), "Meskerem 1, 2020");
  for (const [year, month, day] of [[2026, 11, 25], [2028, 2, 29], [2030, 1, 7]] as const) {
    const jdn = gregorianToJDN(year, month, day);
    assert.deepEqual(jdnToGregorian(jdn), { year, month, day }, "Gregorian round trip");
    assert.ok(jdnToEthiopian(jdn).month >= 1 && jdnToEthiopian(jdn).month <= 13);
  }
});

test("the Ethiopian clock counts from 6 AM and 6 PM, with the part of the day", () => {
  assert.equal(ethiopianClockText(9, 0), "3:00 in the morning");
  assert.equal(ethiopianClockText(6, 0), "12:00 in the morning");
  assert.equal(ethiopianClockText(12, 0), "6:00 in the afternoon", "noon");
  assert.equal(ethiopianClockText(14, 0), "8:00 in the afternoon");
  assert.equal(ethiopianClockText(18, 0), "12:00 in the evening");
  assert.equal(ethiopianClockText(19, 30), "1:30 in the evening");
  assert.equal(ethiopianClockText(0, 0), "6:00 at night", "midnight");
  assert.equal(ethiopianClockText(1, 5), "7:05 at night");
});

test("the confirmation reads Ethiopian date and clock first, then Gregorian with a 12-hour time", () => {
  assert.equal(
    confirmationText(PAYLOAD),
    "Selam Events: You're registered for Banking Forum, Megabit 3, 2019 at 3:00 in the morning (Mar 12, 2027, 9:00 AM). Your code: K7M2Q9XP",
  );
  assert.doesNotMatch(confirmationText(PAYLOAD), /\b(1[3-9]|2[0-3]):\d\d\b/, "never a 24-hour time");
});

test("the event's own time zone decides the date and time, even across midnight", () => {
  assert.match(confirmationText({ ...PAYLOAD, timezone: "Europe/London" }), /Megabit 3, 2019 at 12:00 in the morning \(Mar 12, 2027, 6:00 AM\)/);
  assert.match(
    confirmationText({ ...PAYLOAD, starts_at: "2027-03-11T22:30:00.000Z" }),
    /Megabit 3, 2019 at 7:30 at night \(Mar 12, 2027, 1:30 AM\)/,
    "22:30 UTC is already the 12th in Addis Ababa",
  );
});

test("a long event name is shortened with plain dots; without a start time the date is left out", () => {
  const long = confirmationText({ ...PAYLOAD, event_name: "A".repeat(100) });
  assert.match(long, new RegExp(`for ${"A".repeat(57)}\\.\\.\\., Megabit`));
  assert.ok(!long.includes("…"), "no ellipsis character: it would switch the SMS to a costlier encoding");
  assert.equal(confirmationText({ ...PAYLOAD, starts_at: null }), "Selam Events: You're registered for Banking Forum. Your code: K7M2Q9XP");
});
