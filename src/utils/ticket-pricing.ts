/**
 * Phase 11: the one rule for a ticket type's price at an instant (purchase-time pricing). Pure, so the public page,
 * the back office, checkout and the free-only single-ticket paths all agree.
 * - A window applies from starts_at (included) to ends_at (excluded); ends_at null means until the schedule changes.
 * - Inside a window, its exact price; outside every window, the ticket type's regular price. No windows: the regular
 *   price, as before Phase 11.
 * - valid_until: when this price next changes (the window's end, or the next window's start), null when it doesn't.
 * Windows of one type never overlap (the service refuses that), so at most one applies.
 */
export type PriceWindowLike = { id?: string; starts_at: Date; ends_at: Date | null; price: string };
export type PriceQuote = { price: string; window_id: string | null; valid_until: Date | null };

export function effectivePrice(regularPrice: string, windows: readonly PriceWindowLike[], at: Date): PriceQuote {
  const time = at.getTime();
  const current = windows.find((window) => window.starts_at.getTime() <= time && (window.ends_at === null || time < window.ends_at.getTime()));
  const nextStart = windows
    .map((window) => window.starts_at.getTime())
    .filter((start) => start > time)
    .reduce<number | null>((soonest, start) => (soonest === null || start < soonest ? start : soonest), null);
  if (current) {
    return { price: current.price, window_id: current.id ?? null, valid_until: current.ends_at };
  }
  return { price: regularPrice, window_id: null, valid_until: nextStart === null ? null : new Date(nextStart) };
}

export type WindowIssue = { index: number; message: string; code: "invalid_range" | "overlapping_window" };

/**
 * Problems in a submitted schedule: an end not after its start, and overlaps (two open-ended windows, or an
 * open-ended window followed by another, count as overlapping). Adjacent windows (one ends where the next starts)
 * are fine. Indexes refer to the submitted order.
 */
export function windowIssues(windows: readonly { starts_at: Date; ends_at?: Date | null | undefined }[]): WindowIssue[] {
  const issues: WindowIssue[] = [];
  windows.forEach((window, index) => {
    if (window.ends_at !== null && window.ends_at !== undefined && window.ends_at.getTime() <= window.starts_at.getTime()) {
      issues.push({ index, message: "ends_at must be after starts_at", code: "invalid_range" });
    }
  });
  const sorted = windows.map((window, index) => ({ window, index })).sort((a, b) => a.window.starts_at.getTime() - b.window.starts_at.getTime());
  for (let position = 1; position < sorted.length; position += 1) {
    const previous = sorted[position - 1] as (typeof sorted)[number];
    const next = sorted[position] as (typeof sorted)[number];
    const previousEnd = previous.window.ends_at ?? null;
    if (previousEnd === null || previousEnd.getTime() > next.window.starts_at.getTime()) {
      issues.push({ index: next.index, message: `This window overlaps window ${previous.index + 1}`, code: "overlapping_window" });
    }
  }
  return issues;
}
