import type { Transaction } from "sequelize";
import { sequelize } from "../db.js";
import { NotFoundError } from "../errors/app-errors.js";

/** Indirection point so unit tests can run services without a database (see tests/helpers). */
export const transactionManager = {
  run<T>(work: (transaction: Transaction) => Promise<T>): Promise<T> {
    return sequelize.transaction((transaction) => work(transaction));
  },
};

/**
 * Managed transaction: commits when `work` resolves, rolls back when it throws.
 * Only services open transactions; every repository call inside receives `{ transaction }`.
 */
export function runTransaction<T>(work: (transaction: Transaction) => Promise<T>): Promise<T> {
  return transactionManager.run(work);
}

export function ensureFound<T>(row: T | null | undefined, message: string): T {
  if (row === null || row === undefined) {
    throw new NotFoundError(message);
  }
  return row;
}
