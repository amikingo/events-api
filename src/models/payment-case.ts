import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../db.js";

/**
 * REFUND_REQUIRED (paid after the places were released, none left), PAID_TWICE (a second attempt also succeeded),
 * AMOUNT_MISMATCH (Cheche Pay verified another amount), TICKET_RETURN (a paid ticket returned, Phase 8 step 4).
 */
export const PAYMENT_CASE_KINDS = ["REFUND_REQUIRED", "PAID_TWICE", "AMOUNT_MISMATCH", "TICKET_RETURN"] as const;
export type PaymentCaseKind = (typeof PAYMENT_CASE_KINDS)[number];

export const PAYMENT_CASE_STATUSES = ["OPEN", "RESOLVED"] as const;
export type PaymentCaseStatus = (typeof PAYMENT_CASE_STATUSES)[number];

/** REFUNDED: the money went back through the organizer's merchant account; CLOSED_WITHOUT_REFUND: with a note why. */
export const PAYMENT_CASE_RESOLUTIONS = ["REFUNDED", "CLOSED_WITHOUT_REFUND"] as const;
export type PaymentCaseResolution = (typeof PAYMENT_CASE_RESOLUTIONS)[number];

/**
 * One money issue staff resolve by hand (Phase 8 step 3). A payment case is identified by its payment attempt
 * (`tx_ref`), a return by its ticket (`registration_id`). `amount` and `refunded_amount` are NUMERIC(12,2), returned
 * as strings.
 */
export class PaymentCase extends Model<InferAttributes<PaymentCase>, InferCreationAttributes<PaymentCase>> {
  declare id: CreationOptional<string>;
  declare organization_id: string;
  declare event_id: string;
  declare order_id: string;
  declare order_payment_id: string | null;
  declare registration_id: CreationOptional<string | null>;
  declare kind: PaymentCaseKind;
  declare tx_ref: CreationOptional<string | null>;
  declare amount: string;
  declare currency: string;
  declare status: CreationOptional<PaymentCaseStatus>;
  declare resolution: CreationOptional<PaymentCaseResolution | null>;
  declare refunded_amount: CreationOptional<string | null>;
  declare refunded_currency: CreationOptional<string | null>;
  declare merchant_reference: CreationOptional<string | null>;
  declare note: CreationOptional<string | null>;
  declare resolved_by: CreationOptional<string | null>;
  declare resolved_at: CreationOptional<Date | null>;
  declare created_by: CreationOptional<string | null>;
  declare created_at: CreationOptional<Date>;
  declare updated_at: CreationOptional<Date>;
}

export type PaymentCaseRow = InferAttributes<PaymentCase>;

PaymentCase.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    organization_id: { type: DataTypes.UUID, allowNull: false },
    event_id: { type: DataTypes.UUID, allowNull: false },
    order_id: { type: DataTypes.UUID, allowNull: false },
    order_payment_id: { type: DataTypes.UUID, allowNull: true },
    registration_id: { type: DataTypes.UUID, allowNull: true },
    kind: { type: DataTypes.STRING(30), allowNull: false },
    tx_ref: { type: DataTypes.STRING(255), allowNull: true },
    amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    currency: { type: DataTypes.STRING(3), allowNull: false },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "OPEN" },
    resolution: { type: DataTypes.STRING(30), allowNull: true },
    refunded_amount: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    refunded_currency: { type: DataTypes.STRING(3), allowNull: true },
    merchant_reference: { type: DataTypes.STRING(255), allowNull: true },
    note: { type: DataTypes.STRING(1000), allowNull: true },
    resolved_by: { type: DataTypes.UUID, allowNull: true },
    resolved_at: { type: DataTypes.DATE, allowNull: true },
    created_by: { type: DataTypes.UUID, allowNull: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  { sequelize, modelName: "PaymentCase", tableName: "payment_case" },
);
