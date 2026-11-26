import assert from "node:assert/strict";
import { test } from "node:test";
import { toRegistrationDto } from "../src/mappers/registration.mapper.js";
import { dateCells, GUEST_CSV_HEADERS, guestListCsv, mobileCell, safeCell } from "../src/utils/guest-csv.js";
import { personRow, registrationRow, orderSummary, ticketTypeRow } from "./helpers/fixtures.js";

/** The guest list CSV (Phase 4d): pure, no database. */
const ADDIS = "Africa/Addis_Ababa";

function dto(overrides: { registration?: Parameters<typeof registrationRow>[0]; person?: Parameters<typeof personRow>[0] } = {}, confirmation: Parameters<typeof toRegistrationDto>[1] = null) {
  return toRegistrationDto({ ...registrationRow(overrides.registration), person: personRow(overrides.person), ticketType: ticketTypeRow(), order: orderSummary() }, confirmation);
}

test("the file starts with a byte-order mark and the header row, and ends every line with CRLF", () => {
  const csv = guestListCsv([], ADDIS);
  assert.ok(csv.startsWith("\uFEFF"), "Excel reads Amharic correctly only with the BOM");
  assert.equal(csv, `\uFEFF${GUEST_CSV_HEADERS.join(",")}\r\n`);
  assert.deepEqual(GUEST_CSV_HEADERS.slice(-6), ["Registered (Ethiopian)", "Registered (Gregorian)", "Cancelled (Ethiopian)", "Cancelled (Gregorian)", "Order", "Buyer mobile"]);
});

test("a row: code, status, names, mobile, email, organization, ticket type, how they signed up, SMS, then Ethiopian before Gregorian dates", () => {
  // 2026-11-25 07:30 UTC is 10:30 AM in Addis Ababa: Hidar 16, 2019 at 4:30 in the morning.
  const row = dto(
    { registration: { registered_at: new Date("2026-11-25T07:30:00Z"), source: "PUBLIC" }, person: { affiliation_name: "ABC Bank" } },
    { status: "SENT", sent_at: null },
  );
  const line = guestListCsv([row], ADDIS).split("\r\n")[1];
  assert.equal(
    line,
    'K7M2Q9XP,Confirmed,Hana,Bekele,0911 234 567,hana@example.et,ABC Bank,General Admission,Online,Sent,"Hidar 16, 2019 at 4:30 in the morning","Nov 25, 2026, 10:30 AM",,,K7M2Q9XP,0911 234 567',
  );
});

test("dates follow the event's time zone and the 12-hour clock; an empty date is two empty cells", () => {
  const [ethiopian, gregorian] = dateCells(new Date("2026-11-25T16:05:00Z"), ADDIS); // 7:05 PM in Addis Ababa
  assert.equal(ethiopian, '"Hidar 16, 2019 at 1:05 in the evening"');
  assert.equal(gregorian, '"Nov 25, 2026, 7:05 PM"');
  assert.doesNotMatch(gregorian, /19:05/, "never 24-hour");
  assert.deepEqual(dateCells(null, ADDIS), ["", ""]);
});

test("commas, quotes and line breaks are escaped; Amharic text is kept as it is", () => {
  assert.equal(safeCell('Selam "Sami", Jr.'), '"Selam ""Sami"", Jr."');
  assert.equal(safeCell("two\nlines"), '"two\nlines"');
  assert.equal(safeCell("ሰላም ተስፋዬ"), "ሰላም ተስፋዬ");
  assert.equal(safeCell(null), "");
});

test("a cell that starts like a formula gets a leading apostrophe", () => {
  for (const value of ["=HYPERLINK(\"x\")", "+1 202 555 0100", "-2+3", "@SUM(A1)", "\tx", "\rx"]) {
    assert.ok(safeCell(value).replace(/^"/, "").startsWith("'"), value);
  }
  assert.equal(safeCell("Hana"), "Hana");
});

test("an Ethiopian mobile is written as 0911 234 567; other numbers go through the formula rule", () => {
  assert.equal(mobileCell("+251911234567"), "0911 234 567");
  assert.equal(mobileCell("+251711234567"), "0711 234 567");
  assert.equal(mobileCell("+44 20 7946 0958"), "'+44 20 7946 0958");
  assert.equal(mobileCell(null), "");
});

test("statuses, sources and SMS states read as words; a cancelled guest has cancelled dates", () => {
  const cancelled = dto(
    { registration: { status: "CANCELLED", source: "STAFF", cancelled_at: new Date("2026-11-26T09:00:00Z") }, person: { phone: null } },
    null,
  );
  const cells = guestListCsv([cancelled], ADDIS).split("\r\n")[1] ?? "";
  assert.match(cells, /^K7M2Q9XP,Cancelled,Hana,Bekele,,hana@example.et,,General Admission,Added by staff,No mobile,/);
  // Phase 7: the cancelled date is followed by the order reference and the buyer's mobile.
  assert.match(cells, /"Nov 26, 2026, 12:00 PM",K7M2Q9XP,0911 234 567$/);
});

test("Phase 7: an unnamed ticket reads Unnamed ticket, with its order and buyer mobile in the last columns", () => {
  const row = toRegistrationDto({ ...registrationRow({ person_id: null }), person: null, ticketType: ticketTypeRow(), order: orderSummary({ reference: "ORDER23456" }) });
  const cells = guestListCsv([row], ADDIS).split("\r\n")[1]?.split(",") ?? [];
  assert.deepEqual(cells.slice(2, 7), ["Unnamed ticket", "", "", "", ""]);
  assert.deepEqual(cells.slice(-2), ["ORDER23456", "0911 234 567"]);
});
