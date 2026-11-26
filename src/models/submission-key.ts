import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../db.js";

export const SUBMISSION_SCOPES = ["PUBLIC_REGISTRATION", "STAFF_REGISTRATION", "PUBLIC_CHECKOUT", "STAFF_CHECKOUT"] as const;
export type SubmissionScope = (typeof SUBMISSION_SCOPES)[number];

/**
 * The durable retry key of a registration request (spec rule 4): an Idempotency-Key, the hash of the request it
 * was first used with, and the registration that request produced. Since Phase 7 a checkout key points at the order
 * instead (exactly one of registration_id and order_id is set).
 */
export class SubmissionKey extends Model<InferAttributes<SubmissionKey>, InferCreationAttributes<SubmissionKey>> {
  declare id: CreationOptional<string>;
  declare organization_id: string;
  declare scope: SubmissionScope;
  declare key: string;
  declare request_hash: string;
  declare registration_id: string | null;
  declare order_id: string | null;
  declare created_at: CreationOptional<Date>;
  declare updated_at: CreationOptional<Date>;
}

export type SubmissionKeyRow = InferAttributes<SubmissionKey>;

SubmissionKey.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    organization_id: { type: DataTypes.UUID, allowNull: false },
    scope: { type: DataTypes.STRING(40), allowNull: false },
    key: { type: DataTypes.STRING(128), allowNull: false },
    request_hash: { type: DataTypes.STRING(64), allowNull: false },
    registration_id: { type: DataTypes.UUID, allowNull: true },
    order_id: { type: DataTypes.UUID, allowNull: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  { sequelize, modelName: "SubmissionKey", tableName: "submission_key" },
);
