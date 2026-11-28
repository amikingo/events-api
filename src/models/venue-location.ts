import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../db.js";

/** Where a venue is on a map (table `venue_location`, at most one per venue). No row means no pin. */
export class VenueLocation extends Model<InferAttributes<VenueLocation>, InferCreationAttributes<VenueLocation>> {
  declare id: CreationOptional<string>;
  declare organization_id: string;
  declare venue_id: string;
  /** Degrees (WGS 84). */
  declare latitude: number;
  declare longitude: number;
  declare created_at: CreationOptional<Date>;
  declare updated_at: CreationOptional<Date>;
  declare created_by: string | null;
  declare updated_by: string | null;
}

export type VenueLocationRow = InferAttributes<VenueLocation>;

VenueLocation.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    organization_id: { type: DataTypes.UUID, allowNull: false },
    venue_id: { type: DataTypes.UUID, allowNull: false },
    latitude: { type: DataTypes.DOUBLE, allowNull: false },
    longitude: { type: DataTypes.DOUBLE, allowNull: false },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
    created_by: { type: DataTypes.UUID, allowNull: true },
    updated_by: { type: DataTypes.UUID, allowNull: true },
  },
  { sequelize, modelName: "VenueLocation", tableName: "venue_location" },
);
