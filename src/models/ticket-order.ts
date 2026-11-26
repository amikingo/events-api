import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../db.js";

export const ORDER_STATUSES = ["CONFIRMED"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_SOURCES = ["STAFF", "PUBLIC"] as const;
export type OrderSource = (typeof ORDER_SOURCES)[number];

/**
 * One buyer's checkout at one event (Phase 7; table `ticket_order`). Each ticket is a registration row with
 * `order_id`. The order keeps what was true at checkout: the buyer's delivery mobile (E.164, what the purchase limit
 * counts by), the buyer's verified Cheche account when signed in, the total and the currency. `total_amount` is
 * NUMERIC(12,2), returned as a string so amounts stay exact.
 */
export class TicketOrder extends Model<InferAttributes<TicketOrder>, InferCreationAttributes<TicketOrder>> {
  declare id: CreationOptional<string>;
  declare organization_id: string;
  declare event_id: string;
  declare reference: string;
  declare source: OrderSource;
  declare status: OrderStatus;
  declare buyer_mobile: string | null;
  declare buyer_user_id: string | null;
  declare total_amount: string;
  declare currency: string;
  declare created_at: CreationOptional<Date>;
  declare updated_at: CreationOptional<Date>;
  declare created_by: string | null;
  declare updated_by: string | null;
}

export type TicketOrderRow = InferAttributes<TicketOrder>;

TicketOrder.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    organization_id: { type: DataTypes.UUID, allowNull: false },
    event_id: { type: DataTypes.UUID, allowNull: false },
    reference: { type: DataTypes.STRING(10), allowNull: false },
    source: { type: DataTypes.STRING(20), allowNull: false },
    status: { type: DataTypes.STRING(20), allowNull: false },
    buyer_mobile: { type: DataTypes.STRING(16), allowNull: true },
    buyer_user_id: { type: DataTypes.UUID, allowNull: true },
    total_amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    currency: { type: DataTypes.STRING(3), allowNull: false },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
    created_by: { type: DataTypes.UUID, allowNull: true },
    updated_by: { type: DataTypes.UUID, allowNull: true },
  },
  { sequelize, modelName: "TicketOrder", tableName: "ticket_order" },
);
