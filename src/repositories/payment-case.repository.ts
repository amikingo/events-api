import { UniqueConstraintError, type CreationAttributes } from "sequelize";
import { sequelize } from "../db.js";
import { PaymentCase } from "../models/index.js";
import type { PaymentCaseKind, PaymentCaseRow, PaymentCaseStatus } from "../models/payment-case.js";
import { toPlain, toPlainList } from "../utils/sequelize.js";
import { lockOptions, txOptions, type RepoOptions, type WriteOptions } from "./helpers.js";

/** Explicit projection: never `SELECT *`. */
const attributes = [
  "id",
  "organization_id",
  "event_id",
  "order_id",
  "order_payment_id",
  "registration_id",
  "kind",
  "tx_ref",
  "amount",
  "currency",
  "status",
  "resolution",
  "refunded_amount",
  "refunded_currency",
  "merchant_reference",
  "note",
  "resolved_by",
  "resolved_at",
  "created_by",
  "created_at",
  "updated_at",
] as const satisfies readonly (keyof PaymentCaseRow)[];

export type PaymentCaseResolutionValues = Pick<
  PaymentCaseRow,
  "status" | "resolution" | "refunded_amount" | "refunded_currency" | "merchant_reference" | "note" | "resolved_by" | "resolved_at"
>;

/**
 * Opens a case unless its issue already has one (the unique attempt or return key): null then, and the caller reads
 * the existing case. A savepoint keeps the caller's transaction usable after a conflict.
 */
async function createUnlessTaken(values: CreationAttributes<PaymentCase>, options: WriteOptions): Promise<PaymentCaseRow | null> {
  try {
    return await sequelize.transaction({ transaction: options.transaction ?? undefined }, async (savepoint) => (await PaymentCase.create(values, { transaction: savepoint })).get({ plain: true }));
  } catch (error) {
    if (error instanceof UniqueConstraintError) return null;
    throw error;
  }
}

/** The case of one payment attempt (any kind but a return), tenant-keyed. */
async function findByAttempt(organizationId: string, txRef: string, options: RepoOptions = {}): Promise<PaymentCaseRow | null> {
  const row = await PaymentCase.findOne({
    where: { organization_id: organizationId, tx_ref: txRef, kind: ["REFUND_REQUIRED", "PAID_TWICE", "AMOUNT_MISMATCH"] },
    attributes: [...attributes],
    ...txOptions(options),
    ...lockOptions(options),
  });
  return toPlain<PaymentCaseRow>(row);
}

/** The return case of one ticket, tenant-keyed. */
async function findByReturn(organizationId: string, registrationId: string, options: RepoOptions = {}): Promise<PaymentCaseRow | null> {
  const row = await PaymentCase.findOne({ where: { organization_id: organizationId, registration_id: registrationId, kind: "TICKET_RETURN" }, attributes: [...attributes], ...txOptions(options), ...lockOptions(options) });
  return toPlain<PaymentCaseRow>(row);
}

async function findByOrganizationAndId(organizationId: string, caseId: string, options: RepoOptions = {}): Promise<PaymentCaseRow | null> {
  const row = await PaymentCase.findOne({ where: { organization_id: organizationId, id: caseId }, attributes: [...attributes], ...txOptions(options), ...lockOptions(options) });
  return toPlain<PaymentCaseRow>(row);
}

export type PaymentCaseListFilters = { status?: PaymentCaseStatus | undefined; kind?: PaymentCaseKind | undefined; eventId?: string | undefined; limit: number; offset: number };

/** The organization's cases, newest first. */
async function listByOrganization(organizationId: string, filters: PaymentCaseListFilters, options: RepoOptions = {}): Promise<{ rows: PaymentCaseRow[]; count: number }> {
  const { rows, count } = await PaymentCase.findAndCountAll({
    where: {
      organization_id: organizationId,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.kind ? { kind: filters.kind } : {}),
      ...(filters.eventId ? { event_id: filters.eventId } : {}),
    },
    attributes: [...attributes],
    order: [
      ["created_at", "DESC"],
      ["id", "ASC"],
    ],
    limit: filters.limit,
    offset: filters.offset,
    ...txOptions(options),
  });
  return { rows: toPlainList<PaymentCaseRow>(rows), count };
}

async function resolveById(organizationId: string, caseId: string, values: PaymentCaseResolutionValues, options: WriteOptions = {}): Promise<void> {
  await PaymentCase.update(values, { where: { organization_id: organizationId, id: caseId }, ...txOptions(options) });
}

export const paymentCaseRepository = { createUnlessTaken, findByAttempt, findByReturn, findByOrganizationAndId, listByOrganization, resolveById };
