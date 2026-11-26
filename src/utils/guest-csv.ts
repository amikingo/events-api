import type { RegistrationDto } from "../mappers/registration.mapper.js";
import { ethiopianClockText, ethiopianDateText, gregorianText, localParts } from "./ethiopian-calendar.js";
import { normalizeEthiopianMobile } from "./mobile.js";

/**
 * The guest list as a CSV file (Phase 4d, decided 25 November 2026). Pure: rows in, text out.
 * - UTF-8 with a byte-order mark, so Excel shows Amharic names correctly;
 * - dates in the event's time zone, Ethiopian first ("Hidar 16, 2019 at 4:30 in the morning"), then Gregorian with a
 *   12-hour time ("Nov 25, 2026, 10:30 AM"); never 24-hour;
 * - a cell that starts like a formula gets a leading apostrophe, so a spreadsheet can't run it;
 * - an Ethiopian mobile is written as "0911 234 567": text in Excel, readable, with its leading zero;
 * - Phase 7: an unnamed QUICK ticket reads "Unnamed ticket"; the last two columns are the order reference and the
 *   buyer's mobile.
 */
const BOM = "\uFEFF";

export const GUEST_CSV_HEADERS = [
  "Code",
  "Status",
  "First name",
  "Last name",
  "Mobile",
  "Email",
  "Organization",
  "Ticket type",
  "Signed up",
  "Confirmation SMS",
  "Registered (Ethiopian)",
  "Registered (Gregorian)",
  "Cancelled (Ethiopian)",
  "Cancelled (Gregorian)",
  "Order",
  "Buyer mobile",
  "Checked in (Ethiopian)",
  "Checked in (Gregorian)",
] as const;

const UNNAMED_TICKET = "Unnamed ticket";

/** A cell starting with one of these could run as a formula in a spreadsheet. */
const FORMULA_START = /^[=+\-@\t\r]/;

/** Quotes a cell when it holds a comma, quote or line break; doubles inner quotes. */
function escapeCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Text as it goes into the file: neutralised when it starts like a formula. */
export function safeCell(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  return escapeCell(FORMULA_START.test(value) ? `'${value}` : value);
}

/** "+251911234567" → "0911 234 567"; other numbers are kept as stored (and neutralised by safeCell). */
export function mobileCell(phone: string | null): string {
  if (phone === null || phone === "") return "";
  const mobile = normalizeEthiopianMobile(phone);
  if (!mobile) return safeCell(phone);
  const local = `0${mobile.slice(4)}`;
  return `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}`;
}

/** The two date cells, Ethiopian then Gregorian, in the event's time zone; empty when there is no date. */
export function dateCells(instant: Date | null, timeZone: string): [string, string] {
  if (instant === null) return ["", ""];
  const local = localParts(instant, timeZone);
  return [safeCell(`${ethiopianDateText(local)} at ${ethiopianClockText(local.hour, local.minute)}`), safeCell(gregorianText(local))];
}

// HELD and RELEASED tickets (unpaid orders) never reach the guest list; named here for completeness.
const STATUS_TEXT: Record<RegistrationDto["status"], string> = { CONFIRMED: "Confirmed", CANCELLED: "Cancelled", HELD: "Held for payment", RELEASED: "Released" };
const SOURCE_TEXT: Record<RegistrationDto["source"], string> = { PUBLIC: "Online", STAFF: "Added by staff" };
const SMS_TEXT: Record<NonNullable<RegistrationDto["confirmation"]>["status"], string> = {
  PENDING: "Waiting to send",
  SENT: "Sent",
  FAILED: "Failed",
  SKIPPED: "Not sent",
};

function rowCells(row: RegistrationDto, timeZone: string): string[] {
  return [
    safeCell(row.code),
    STATUS_TEXT[row.status],
    safeCell(row.person ? row.person.first_name : UNNAMED_TICKET),
    safeCell(row.person?.last_name),
    mobileCell(row.person?.phone ?? null),
    safeCell(row.person?.email),
    safeCell(row.person?.affiliation_name),
    safeCell(row.ticket_type.name),
    SOURCE_TEXT[row.source],
    row.confirmation === null ? "No mobile" : SMS_TEXT[row.confirmation.status],
    ...dateCells(row.registered_at, timeZone),
    ...dateCells(row.cancelled_at, timeZone),
    safeCell(row.order.reference),
    mobileCell(row.order.buyer_mobile),
    ...dateCells(row.checked_in_at, timeZone),
  ];
}

/** The whole file: byte-order mark, header row, one line per registration, CRLF line ends (what Excel expects). */
export function guestListCsv(rows: RegistrationDto[], timeZone: string): string {
  const lines = [GUEST_CSV_HEADERS.join(","), ...rows.map((row) => rowCells(row, timeZone).join(","))];
  return `${BOM}${lines.join("\r\n")}\r\n`;
}
