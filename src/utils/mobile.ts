/**
 * Normalizes Ethiopian mobile numbers to E.164 (+2519XXXXXXXX / +2517XXXXXXXX).
 * Returns null for unsupported formats so callers decide how to report it.
 */
export function normalizeEthiopianMobile(value: string): string | null {
  const compact = value.trim().replace(/[\s()-]/g, "");
  if (/^\+251[79]\d{8}$/.test(compact)) return compact;
  if (/^251[79]\d{8}$/.test(compact)) return `+${compact}`;
  if (/^0[79]\d{8}$/.test(compact)) return `+251${compact.slice(1)}`;
  return null;
}
