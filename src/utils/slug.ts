/** Longest slug anywhere (organizations and events): the same limit as the slug validator and the columns. */
export const SLUG_MAX_LENGTH = 120;

/**
 * Keeps Latin letters and digits only, joined by single hyphens. Cuts to `maxLength` before trimming hyphens, so
 * the result never ends in "-". A name written in another script (e.g. Amharic) gives "".
 */
export function slugify(text: string, maxLength = SLUG_MAX_LENGTH): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, maxLength)
    .replace(/^-+|-+$/g, "");
}

/**
 * The first free slug among `base`, `base-2`, `base-3`, … given the slugs already taken.
 * `base` must leave room for the suffix (see EVENT_SLUG_BASE_LENGTH in the event service).
 */
export function firstFreeSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}
