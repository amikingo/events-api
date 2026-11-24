/**
 * PATCH semantics: omitted/undefined keeps the stored value, explicit null clears it,
 * a supplied value replaces it. Only allow-listed fields can ever reach persistence.
 */
export function pickDefined<T extends object, K extends keyof T>(source: T, allowedFields: readonly K[]): Partial<Pick<T, K>> {
  const picked: Partial<Pick<T, K>> = {};
  for (const field of allowedFields) {
    if (Object.hasOwn(source, field) && source[field] !== undefined) {
      picked[field] = source[field];
    }
  }
  return picked;
}
