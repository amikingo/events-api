import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../db.js";

/**
 * A free registration category for one event (spec §7). `capacity = NULL` means no separate limit: the category
 * draws only on the event's overall limit. When both are set, the ticket limit fits within the event limit.
 */
export class TicketType extends Model<InferAttributes<TicketType>, InferCreationAttributes<TicketType>> {
  declare id: CreationOptional<string>;
  declare organization_id: string;
  declare event_id: string;
  declare code: string;
  declare name: string;
  declare capacity: number | null;
  declare display_order: CreationOptional<number>;
  declare is_active: CreationOptional<boolean>;
  declare created_at: CreationOptional<Date>;
  declare updated_at: CreationOptional<Date>;
  declare created_by: string | null;
  declare updated_by: string | null;
}

export type TicketTypeRow = InferAttributes<TicketType>;

TicketType.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    organization_id: { type: DataTypes.UUID, allowNull: false },
    event_id: { type: DataTypes.UUID, allowNull: false },
    code: { type: DataTypes.STRING(80), allowNull: false },
    name: { type: DataTypes.STRING(255), allowNull: false },
    capacity: { type: DataTypes.INTEGER, allowNull: true },
    display_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
    created_by: { type: DataTypes.UUID, allowNull: true },
    updated_by: { type: DataTypes.UUID, allowNull: true },
  },
  { sequelize, modelName: "TicketType", tableName: "ticket_type" },
);
