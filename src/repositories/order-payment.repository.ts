import type { CreationAttributes } from "sequelize";
import { OrderPayment } from "../models/index.js";
import type { OrderPaymentRow } from "../models/order-payment.js";
import { toPlain } from "../utils/sequelize.js";
import { lockOptions, txOptions, type RepoOptions, type WriteOptions } from "./helpers.js";

const attributes = [
  "id",
  "organization_id",
  "order_id",
  "payment_option_id",
  "cheche_pay_service",
  "amount",
  "currency",
  "status",
  "checkout_url",
  "vendor_ref",
  "provider_order_id",
  "notify_time",
  "request_object",
  "response_object",
  "last_notification",
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

/** By its id: the `transaction_id` Cheche Pay echoes in its callback. */
async function findById(id: string, options: RepoOptions = {}): Promise<OrderPaymentRow | null> {
  const row = await OrderPayment.findOne({ where: { id }, attributes: [...attributes], ...txOptions(options), ...lockOptions(options) });
  return toPlain<OrderPaymentRow>(row);
}

/** By Cheche Pay's own order id from createOrder (the callback fallback, as bookings does with merch_order_id). */
async function findByProviderOrderId(providerOrderId: string, options: RepoOptions = {}): Promise<OrderPaymentRow | null> {
  const row = await OrderPayment.findOne({ where: { provider_order_id: providerOrderId }, attributes: [...attributes], ...txOptions(options), ...lockOptions(options) });
  return toPlain<OrderPaymentRow>(row);
}

export type PaymentUpdateValues = Partial<
  Pick<OrderPaymentRow, "status" | "checkout_url" | "vendor_ref" | "provider_order_id" | "notify_time" | "request_object" | "response_object" | "last_notification" | "last_error">
>;

async function updateById(id: string, values: PaymentUpdateValues, options: WriteOptions = {}): Promise<void> {
  const lastError = values.last_error === undefined ? {} : { last_error: values.last_error === null ? null : values.last_error.slice(0, 500) };
  await OrderPayment.update({ ...values, ...lastError }, { where: { id }, ...txOptions(options) });
}

export const orderPaymentRepository = { create, findByOrder, findById, findByProviderOrderId, updateById };
