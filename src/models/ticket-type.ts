import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../db.js";

/** Phase 7: PUBLIC types are open to anyone with the link; STAFF_ONLY types only authorized staff may issue. */
export const TICKET_AUDIENCES = ["PUBLIC", "STAFF_ONLY"] as const;
export type TicketAudience = (typeof TICKET_AUDIENCES)[number];

/**
 * A registration category for one event (spec §7). Since Phase 7 it has a price (exact, a decimal string such as
 * "500.00"; "0.00" is free) in the organizer's currency, copied when it is created, and an audience.
 * `capacity = NULL` means no separate limit: the category
 * draws only on the event's overall limit. When both are set, the ticket limit fits within the event limit.
 */
export class TicketType extends Model<InferAttributes<TicketType>, InferCreationAttributes<TicketType>> {
  declare id: CreationOptional<string>;
  declare organization_id: string;
  declare event_id: string;
  declare code: string;
  declare name: string;
  declare capacity: number | null;
  /** NUMERIC(12,2): Postgres returns it as a string, which keeps amounts exact. */
  declare price: CreationOptional<string>;
  declare currency: string;
  declare audience: CreationOptional<TicketAudience>;
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
    price: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: "0.00" },
    currency: { type: DataTypes.STRING(3), allowNull: false },
    audience: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "PUBLIC" },
    display_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
    created_by: { type: DataTypes.UUID, allowNull: true },
    updated_by: { type: DataTypes.UUID, allowNull: true },
  },
  { sequelize, modelName: "TicketType", tableName: "ticket_type" },
);
