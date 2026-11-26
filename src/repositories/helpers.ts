import { literal, Transaction, type LOCK, type Model, type ModelStatic } from "sequelize";
import { sequelize } from "../db.js";

/**
 * The single options convention for every repository method: the LAST parameter,
 * always an object, never a bare transaction.
 */
export type RepoOptions = {
  transaction?: Transaction | null;
  /**
   * true: SELECT ... FOR UPDATE. "keyShare": SELECT ... FOR KEY SHARE, which only keeps the row from being locked
   * FOR UPDATE meanwhile (taken first by paths that write rows pointing at it, to keep the lock order: Phase 8
   * check-in). Only valid inside a transaction.
   */
  lock?: boolean | "keyShare";
};

export type WriteOptions = { transaction?: Transaction | null };

export function txOptions(options: RepoOptions = {}): { transaction: Transaction | null } {
  return { transaction: options.transaction ?? null };
}

/** Builds Sequelize lock options. Pass `of` when the query includes outer-joined associations. */
export function lockOptions(
  options: RepoOptions,
  of?: ModelStatic<Model>,
): { lock?: LOCK | { level: LOCK; of: ModelStatic<Model> } } {
  if (!options.lock) return {};
  if (!options.transaction) {
    throw new Error("Repository lock requested without a transaction");
  }
  const level = options.lock === "keyShare" ? Transaction.LOCK.KEY_SHARE : Transaction.LOCK.UPDATE;
  return { lock: of ? { level, of } : level };
}

/**
 * Serializes concurrent work on one logical key until the surrounding transaction ends
 * (e.g. "one active assignment per user+role"). Always transaction-scoped.
 */
export async function acquireAdvisoryXactLock(
  group: string,
  key: string,
  options: { transaction: Transaction },
): Promise<void> {
  await sequelize.query("SELECT pg_advisory_xact_lock(hashtext(:group), hashtext(:key))", {
    replacements: { group, key },
    transaction: options.transaction,
  });
}

/**
 * The ids of switched-on modules, as a subquery for `{ module_id: { [Op.in]: activeModuleIds() } }` (Phase 2e).
 * Replacing a grant set deletes only the rows of switched-on modules: the form never shows a switched-off module, so
 * its grants are kept for when it is switched back on.
 */
export function activeModuleIds(): ReturnType<typeof literal> {
  return literal('(SELECT "id" FROM "module" WHERE "is_active" = true)');
}
