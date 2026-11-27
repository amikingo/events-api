import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../db.js";

/**
 * INITIATED (created, or sent to Cheche Pay), PAID (merchant-verify confirmed SUCCEEDED for the stored amount),
 * MISMATCH (merchant-verify reported SUCCEEDED for another amount: kept for review, nothing issued).
 */
export const PAYMENT_STATUSES = ["INITIATED", "PAID", "MISMATCH"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Whether a Cheche Pay test key (sk_test_) or live key (sk_live_) is used. */
export const KEY_MODES = ["test", "live"] as const;
export type KeyMode = (typeof KEY_MODES)[number];

/**
 * The Cheche Pay v2 payment of one paid order (Phase 7 step 3b), shaped like bookings' payment item. Each attempt
 * gets a new `tx_ref` (`<id>-<suffix>`, since v2 refuses a reused one); the payment id is read back from it.
 * `paid_tx_ref` is the attempt that paid. `amount` is NUMERIC(12,2), returned as a string.
 */
export class OrderPayment extends Model<InferAttributes<OrderPayment>, InferCreationAttributes<OrderPayment>> {
  declare id: CreationOptional<string>;
  declare organization_id: string;
  declare order_id: string;
  declare amount: string;
  declare currency: string;
  declare status: PaymentStatus;
  declare tx_ref: CreationOptional<string | null>;
  declare checkout_url: CreationOptional<string | null>;
  declare checkout_expires_at: CreationOptional<Date | null>;
  declare provider_transaction_id: CreationOptional<string | null>;
  declare key_mode: CreationOptional<KeyMode | null>;
  declare paid_tx_ref: CreationOptional<string | null>;
  declare verified_at: CreationOptional<Date | null>;
  /** Phase 9: when the payment succeeded, as merchant-verify reports it (null when it doesn't say). */
  declare succeeded_at: CreationOptional<Date | null>;
  declare request_object: CreationOptional<Record<string, unknown> | null>;
  declare response_object: unknown;
  declare last_verification: CreationOptional<Record<string, unknown> | null>;
  declare last_error: CreationOptional<string | null>;
  declare created_at: CreationOptional<Date>;
  declare updated_at: CreationOptional<Date>;
}

export type OrderPaymentRow = InferAttributes<OrderPayment>;

OrderPayment.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    organization_id: { type: DataTypes.UUID, allowNull: false },
    order_id: { type: DataTypes.UUID, allowNull: false },
    amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    currency: { type: DataTypes.STRING(3), allowNull: false },
    status: { type: DataTypes.STRING(20), allowNull: false },
    tx_ref: { type: DataTypes.STRING(100), allowNull: true },
    checkout_url: { type: DataTypes.STRING(2000), allowNull: true },
    checkout_expires_at: { type: DataTypes.DATE, allowNull: true },
    provider_transaction_id: { type: DataTypes.STRING(255), allowNull: true },
    key_mode: { type: DataTypes.STRING(10), allowNull: true },
    paid_tx_ref: { type: DataTypes.STRING(255), allowNull: true },
    verified_at: { type: DataTypes.DATE, allowNull: true },
    succeeded_at: { type: DataTypes.DATE, allowNull: true },
    request_object: { type: DataTypes.JSONB, allowNull: true },
    response_object: { type: DataTypes.JSONB, allowNull: true },
    last_verification: { type: DataTypes.JSONB, allowNull: true },
    last_error: { type: DataTypes.STRING(500), allowNull: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  { sequelize, modelName: "OrderPayment", tableName: "order_payment" },
);
