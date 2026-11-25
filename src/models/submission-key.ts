import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../db.js";

export const SUBMISSION_SCOPES = ["PUBLIC_REGISTRATION", "STAFF_REGISTRATION"] as const;
export type SubmissionScope = (typeof SUBMISSION_SCOPES)[number];

/**
 * The durable retry key of a registration request (spec rule 4): an Idempotency-Key, the hash of the request it
 * was first used with, and the registration that request produced.
 */
export class SubmissionKey extends Model<InferAttributes<SubmissionKey>, InferCreationAttributes<SubmissionKey>> {
  declare id: CreationOptional<string>;
  declare organization_id: string;
  declare scope: SubmissionScope;
  declare key: string;
  declare request_hash: string;
  declare registration_id: string;
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
    registration_id: { type: DataTypes.UUID, allowNull: false },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  { sequelize, modelName: "SubmissionKey", tableName: "submission_key" },
);
