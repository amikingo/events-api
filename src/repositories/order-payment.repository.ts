import type { CreationAttributes } from "sequelize";
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

export const orderPaymentRepository = { create, findByOrder, findById, updateById };
