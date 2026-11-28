import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../db.js";

export type TicketQrSize = "s" | "m" | "l";

/**
 * How an event's tickets look (table `event_ticket_design`, at most one per event). No row means the booking site's
 * standard designs. The pictures are `file` rows of the same organization.
 */
export class EventTicketDesign extends Model<InferAttributes<EventTicketDesign>, InferCreationAttributes<EventTicketDesign>> {
  declare id: CreationOptional<string>;
  declare organization_id: string;
  declare event_id: string;
  /** The booking site's name for a layout; "custom" is the organizer's own artwork. */
  declare design: string;
  /** A named colour or #rrggbb; null keeps the design's own colours. */
  declare color: string | null;
  declare note: string | null;
  declare show_price: CreationOptional<boolean>;
  declare show_venue: CreationOptional<boolean>;
  declare show_guest: CreationOptional<boolean>;
  /** Where the QR panel goes on custom artwork, from 0 to 1 across and down. */
  declare qr_x: CreationOptional<number>;
  declare qr_y: CreationOptional<number>;
  declare qr_size: CreationOptional<TicketQrSize>;
  declare logo_file_id: CreationOptional<string | null>;
  declare picture_file_id: CreationOptional<string | null>;
  declare artwork_file_id: CreationOptional<string | null>;
  declare created_at: CreationOptional<Date>;
  declare updated_at: CreationOptional<Date>;
  declare created_by: string | null;
  declare updated_by: string | null;
}

export type EventTicketDesignRow = InferAttributes<EventTicketDesign>;

EventTicketDesign.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    organization_id: { type: DataTypes.UUID, allowNull: false },
    event_id: { type: DataTypes.UUID, allowNull: false },
    design: { type: DataTypes.STRING(30), allowNull: false },
    color: { type: DataTypes.STRING(20), allowNull: true },
    note: { type: DataTypes.STRING(60), allowNull: true },
    show_price: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    show_venue: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    show_guest: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    qr_x: { type: DataTypes.DOUBLE, allowNull: false, defaultValue: 0.5 },
    qr_y: { type: DataTypes.DOUBLE, allowNull: false, defaultValue: 1 },
    qr_size: { type: DataTypes.STRING(1), allowNull: false, defaultValue: "m" },
    logo_file_id: { type: DataTypes.UUID, allowNull: true },
    picture_file_id: { type: DataTypes.UUID, allowNull: true },
    artwork_file_id: { type: DataTypes.UUID, allowNull: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
    created_by: { type: DataTypes.UUID, allowNull: true },
    updated_by: { type: DataTypes.UUID, allowNull: true },
  },
  { sequelize, modelName: "EventTicketDesign", tableName: "event_ticket_design" },
);
