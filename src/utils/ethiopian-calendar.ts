/**
 * Gregorian ↔ Ethiopian calendar, ported from events-web/lib/calendar.ts (itself ported from the guideline's
 * date-picker script), so the web app and the SMS always name the same day. Everything goes through the Julian Day
 * Number. Plus the Ethiopian clock, which counts hours from 6 AM and 6 PM.
 */
const JD_EPOCH_ETHIOPIC = 1723856;
const emod = (a: number, b: number) => ((a % b) + b) % b;

export type YMD = { year: number; month: number; day: number };

export const ETH_MONTHS = ["Meskerem", "Tikimt", "Hidar", "Tahsas", "Tir", "Yekatit", "Megabit", "Miazia", "Ginbot", "Sene", "Hamle", "Nehase", "Pagume"] as const;
const GREG_MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export function gregorianToJDN(year: number, month: number, day: number): number {
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  return day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
}

export function jdnToGregorian(jdn: number): YMD {
  const a = jdn + 32044;
  const b = Math.floor((4 * a + 3) / 146097);
  const c = a - Math.floor((146097 * b) / 4);
  const d = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor((1461 * d) / 4);
  const m = Math.floor((5 * e + 2) / 153);
  return {
    day: e - Math.floor((153 * m + 2) / 5) + 1,
    month: m + 3 - 12 * Math.floor(m / 10),
    year: 100 * b + d - 4800 + Math.floor(m / 10),
  };
}

export function jdnToEthiopian(jdn: number): YMD {
  const r = emod(jdn - JD_EPOCH_ETHIOPIC, 1461);
  const n = emod(r, 365) + 365 * Math.floor(r / 1460);
  return {
    year: 4 * Math.floor((jdn - JD_EPOCH_ETHIOPIC) / 1461) + Math.floor(r / 365) - Math.floor(r / 1460),
    month: Math.floor(n / 30) + 1,
    day: emod(n, 30) + 1,
  };
}

/** The wall-clock date and time of an instant in an IANA time zone (24-hour internally; never shown that way). */
export function localParts(instant: Date, timeZone: string): YMD & { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute") };
}

/** "Megabit 3, 2019" for a local Gregorian date. */
export function ethiopianDateText(local: YMD): string {
  const ethiopian = jdnToEthiopian(gregorianToJDN(local.year, local.month, local.day));
  return `${ETH_MONTHS[ethiopian.month - 1] ?? ""} ${ethiopian.day}, ${ethiopian.year}`;
}

/**
 * The Ethiopian clock: hours count from 6 AM (morning, afternoon) and 6 PM (evening, night), so 9:00 AM is "3:00 in
 * the morning" and 7:30 PM is "1:30 in the evening".
 */
export function ethiopianClockText(hour: number, minute: number): string {
  const ethiopianHour = (hour + 6) % 12 === 0 ? 12 : (hour + 6) % 12;
  const part = hour >= 6 && hour < 12 ? "in the morning" : hour >= 12 && hour < 18 ? "in the afternoon" : hour >= 18 ? "in the evening" : "at night";
  return `${ethiopianHour}:${String(minute).padStart(2, "0")} ${part}`;
}

/** "Mar 12, 2027, 9:00 AM": Gregorian with a 12-hour time. */
export function gregorianText(local: YMD & { hour: number; minute: number }): string {
  const hour12 = local.hour % 12 === 0 ? 12 : local.hour % 12;
  const meridiem = local.hour < 12 ? "AM" : "PM";
  return `${GREG_MONTHS_SHORT[local.month - 1] ?? ""} ${local.day}, ${local.year}, ${hour12}:${String(local.minute).padStart(2, "0")} ${meridiem}`;
}
