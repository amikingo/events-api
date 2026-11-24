/**
 * IANA time zones, checked with the runtime's own time-zone database (no dependency).
 * Returns the canonical spelling (e.g. "africa/addis_ababa" → "Africa/Addis_Ababa"), or null when unknown.
 */
export function canonicalTimeZone(value: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

export function isValidTimeZone(value: string): boolean {
  return canonicalTimeZone(value) !== null;
}
