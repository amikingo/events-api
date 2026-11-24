import type { Model } from "sequelize";

/**
 * Repositories return plain rows, never model instances, so services cannot call
 * instance methods (save/update/reload) behind the repository's back.
 * The cast is the single, deliberate typing boundary between Sequelize and the app.
 */
export function toPlain<T>(row: Model | null): T | null {
  return row ? (row.get({ plain: true }) as T) : null;
}

export function toPlainList<T>(rows: readonly Model[]): T[] {
  return rows.map((row) => row.get({ plain: true }) as T);
}
