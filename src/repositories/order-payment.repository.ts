import { QueryTypes, type CreationAttributes } from "sequelize";
import { sequelize } from "../db.js";
import { OrderPayment } from "../models/index.js";
import type { OrderPaymentRow } from "../models/order-payment.js";
import { toPlain } from "../utils/sequelize.js";
import { lockOptions, txOptions, type RepoOptions, type WriteOptions } from "./helpers.js";

const attributes = [
  "id",
  "organization_id",
  "order_id",
  "amount",
  "currency",
  "status",
  "tx_ref",
  "checkout_url",
  "checkout_expires_at",
  "provider_transaction_id",
  "key_mode",
  "paid_tx_ref",
  "verified_at",
  "succeeded_at",
  "request_object",
  "response_object",
  "last_verification",
  "last_error",
  "created_at",
  "updated_at",
] as const satisfies readonly (keyof OrderPaymentRow)[];

async function create(values: CreationAttributes<OrderPayment>, options: WriteOptions = {}): Promise<OrderPaymentRow> {
  const row = await OrderPayment.create(values, txOptions(options));
  return row.get({ plain: true });
}

/** The payment of one order (tenant-keyed). */
async function findByOrder(organizationId: string, orderId: string, options: RepoOptions = {}): Promise<OrderPaymentRow | null> {
  const row = await OrderPayment.findOne({ where: { organization_id: organizationId, order_id: orderId }, attributes: [...attributes], ...txOptions(options), ...lockOptions(options) });
  return toPlain<OrderPaymentRow>(row);
}

/** By its id (read back from a Cheche Pay tx_ref). */
async function findById(id: string, options: RepoOptions = {}): Promise<OrderPaymentRow | null> {
  const row = await OrderPayment.findOne({ where: { id }, attributes: [...attributes], ...txOptions(options), ...lockOptions(options) });
  return toPlain<OrderPaymentRow>(row);
}

/**
 * Phase 10 (the payment worker's safety net): unconfirmed attempts of orders whose hold was released, that Cheche Pay
 * hasn't been asked about since the hold ended, or since the attempt's checkout link expired (when that came later).
 * Oldest hold first. A failed check (Cheche Pay unreachable) leaves the attempt due for the next tick.
 */
async function listDueForCheck(now: Date, limit: number): Promise<Array<{ id: string; organization_id: string; tx_ref: string }>> {
  return sequelize.query<{ id: string; organization_id: string; tx_ref: string }>(
    `SELECT p."id", p."organization_id", p."tx_ref"
       FROM "order_payment" p
       JOIN "ticket_order" o ON o."id" = p."order_id" AND o."organization_id" = p."organization_id"
      WHERE p."status" = 'INITIATED' AND p."tx_ref" IS NOT NULL AND o."status" = 'EXPIRED'
        AND (
          COALESCE((p."last_verification"->>'checked_at')::timestamptz, 'epoch') < o."hold_expires_at"
          OR (p."checkout_expires_at" IS NOT NULL AND p."checkout_expires_at" <= :now
              AND COALESCE((p."last_verification"->>'checked_at')::timestamptz, 'epoch') < p."checkout_expires_at")
        )
      ORDER BY o."hold_expires_at" ASC
      LIMIT :limit`,
    { replacements: { now, limit }, type: QueryTypes.SELECT },
  );
}

export type PaymentUpdateValues = Partial<
  Pick<
    OrderPaymentRow,
    | "status"
    | "tx_ref"
    | "checkout_url"
    | "checkout_expires_at"
    | "provider_transaction_id"
    | "key_mode"
    | "paid_tx_ref"
    | "verified_at"
    | "succeeded_at"
    | "request_object"
    | "response_object"
    | "last_verification"
    | "last_error"
  >
>;

async function updateById(id: string, values: PaymentUpdateValues, options: WriteOptions = {}): Promise<void> {
  const lastError = values.last_error === undefined ? {} : { last_error: values.last_error === null ? null : values.last_error.slice(0, 500) };
  await OrderPayment.update({ ...values, ...lastError }, { where: { id }, ...txOptions(options) });
}

export const orderPaymentRepository = { create, findByOrder, findById, listDueForCheck, updateById };
