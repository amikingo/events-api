/**
 * Exact money (Phase 7). Amounts travel as decimal strings with two places ("500.00"), the way Postgres returns
 * NUMERIC(12,2), and are added in whole cents with BigInt, so no floating-point rounding ever touches a price.
 */
export const MONEY_PATTERN = /^\d{1,10}(\.\d{1,2})?$/;

/** "5" → "5.00", "1200.5" → "1200.50". The input must match MONEY_PATTERN. */
export function normalizeAmount(value: string): string {
  const [whole = "0", fraction = ""] = value.split(".");
  return `${BigInt(whole).toString()}.${fraction.padEnd(2, "0")}`;
}

function toCents(amount: string): bigint {
  const [whole = "0", fraction = ""] = normalizeAmount(amount).split(".");
  return BigInt(whole) * 100n + BigInt(fraction);
}

function fromCents(cents: bigint): string {
  const whole = cents / 100n;
  const fraction = (cents % 100n).toString().padStart(2, "0");
  return `${whole.toString()}.${fraction}`;
}

/** A zero price means the ticket type is free. */
export function isZeroAmount(amount: string): boolean {
  return toCents(amount) === 0n;
}

/** unitPrice × quantity, exactly. */
export function multiplyAmount(unitPrice: string, quantity: number): string {
  return fromCents(toCents(unitPrice) * BigInt(quantity));
}

/** The exact sum of amounts ("0.00" for none). */
export function sumAmounts(amounts: readonly string[]): string {
  return fromCents(amounts.reduce((total, amount) => total + toCents(amount), 0n));
}
