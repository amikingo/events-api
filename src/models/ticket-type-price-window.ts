import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../db.js";

/**
 * Phase 11: one scheduled price of a ticket type, from starts_at (included) to ends_at (excluded; null = until the
 * schedule changes). The price is a decimal string in the ticket type's currency; "0.00" is free.
 */
export class TicketTypePriceWindow extends Model<InferAttributes<TicketTypePriceWindow>, InferCreationAttributes<TicketTypePriceWindow>> {
  declare id: CreationOptional<string>;
  declare organization_id: string;
  declare event_id: string;
  declare ticket_type_id: string;
  declare starts_at: Date;
  declare ends_at: Date | null;
  /** NUMERIC(12,2): Postgres returns it as a string, which keeps amounts exact. */
  declare price: string;
  declare created_at: CreationOptional<Date>;
  declare created_by: string | null;
}

export type TicketTypePriceWindowRow = InferAttributes<TicketTypePriceWindow>;

TicketTypePriceWindow.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    organization_id: { type: DataTypes.UUID, allowNull: false },
    event_id: { type: DataTypes.UUID, allowNull: false },
    ticket_type_id: { type: DataTypes.UUID, allowNull: false },
    starts_at: { type: DataTypes.DATE, allowNull: false },
    ends_at: { type: DataTypes.DATE, allowNull: true },
    price: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    created_at: DataTypes.DATE,
    created_by: { type: DataTypes.UUID, allowNull: true },
  },
  { sequelize, modelName: "TicketTypePriceWindow", tableName: "ticket_type_price_window", updatedAt: false },
);
