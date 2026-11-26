import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../db.js";

/**
 * INITIATED (created, or sent to Cheche Pay), PAID (a matching "Completed" callback), MISMATCH (a "Completed"
 * callback for another amount: kept for review, nothing issued).
 */
export const PAYMENT_STATUSES = ["INITIATED", "PAID", "MISMATCH"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * The Cheche Pay payment of one paid order (Phase 7 step 3), shaped like bookings' payment item. Its `id` is the
 * `transaction_id` Cheche Pay gets at createOrder and echoes in its callback; every retry reuses it. `amount` is
 * NUMERIC(12,2), returned as a string.
 */
export class OrderPayment extends Model<InferAttributes<OrderPayment>, InferCreationAttributes<OrderPayment>> {
  declare id: CreationOptional<string>;
  declare organization_id: string;
  declare order_id: string;
  declare payment_option_id: string;
  declare cheche_pay_service: string;
  declare amount: string;
  declare currency: string;
  declare status: PaymentStatus;
  declare checkout_url: string | null;
  declare vendor_ref: string | null;
  declare provider_order_id: string | null;
  declare notify_time: Date | null;
  declare request_object: Record<string, unknown> | null;
  declare response_object: unknown;
  declare last_notification: Record<string, unknown> | null;
  declare last_error: string | null;
  declare created_at: CreationOptional<Date>;
  declare updated_at: CreationOptional<Date>;
}

export type OrderPaymentRow = InferAttributes<OrderPayment>;

OrderPayment.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    organization_id: { type: DataTypes.UUID, allowNull: false },
    order_id: { type: DataTypes.UUID, allowNull: false },
    payment_option_id: { type: DataTypes.STRING(100), allowNull: false },
    cheche_pay_service: { type: DataTypes.STRING(80), allowNull: false },
    amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    currency: { type: DataTypes.STRING(3), allowNull: false },
    status: { type: DataTypes.STRING(20), allowNull: false },
    checkout_url: { type: DataTypes.STRING(2000), allowNull: true },
    vendor_ref: { type: DataTypes.STRING(255), allowNull: true },
    provider_order_id: { type: DataTypes.STRING(255), allowNull: true },
    notify_time: { type: DataTypes.DATE, allowNull: true },
    request_object: { type: DataTypes.JSONB, allowNull: true },
    response_object: { type: DataTypes.JSONB, allowNull: true },
    last_notification: { type: DataTypes.JSONB, allowNull: true },
    last_error: { type: DataTypes.STRING(500), allowNull: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  { sequelize, modelName: "OrderPayment", tableName: "order_payment" },
);
