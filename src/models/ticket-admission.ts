import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../db.js";

/**
 * One admission of one ticket at its event (Phase 8 step 2): who admitted it and when, and the gate request's retry
 * key. Unique per registration, so a ticket is admitted once for the whole event.
 */
export class TicketAdmission extends Model<InferAttributes<TicketAdmission>, InferCreationAttributes<TicketAdmission>> {
  declare id: CreationOptional<string>;
  declare organization_id: string;
  declare event_id: string;
  declare registration_id: string;
  declare admitted_at: CreationOptional<Date>;
  declare admitted_by: string;
  declare idempotency_key: string;
  declare created_at: CreationOptional<Date>;
}

export type TicketAdmissionRow = InferAttributes<TicketAdmission>;

TicketAdmission.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    organization_id: { type: DataTypes.UUID, allowNull: false },
    event_id: { type: DataTypes.UUID, allowNull: false },
    registration_id: { type: DataTypes.UUID, allowNull: false },
    admitted_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    admitted_by: { type: DataTypes.UUID, allowNull: false },
    idempotency_key: { type: DataTypes.STRING(128), allowNull: false },
    created_at: DataTypes.DATE,
  },
  { sequelize, modelName: "TicketAdmission", tableName: "ticket_admission", updatedAt: false },
);
