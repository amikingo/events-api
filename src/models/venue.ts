import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
} from "sequelize";
import { sequelize } from "../db.js";
import type { Organization } from "./organization.js";

/**
 * A reusable physical location (spec §4). `capacity` describes the place; an event's own capacity sets its booking
 * limit. `country` is an ISO 3166-1 alpha-2 code (e.g. ET).
 */
export class Venue extends Model<InferAttributes<Venue>, InferCreationAttributes<Venue>> {
  declare id: CreationOptional<string>;
  declare organization_id: string;
  declare name: string;
  declare address: string | null;
  declare city: string | null;
  declare country: string | null;
  declare capacity: number | null;
  declare is_active: CreationOptional<boolean>;
  declare created_at: CreationOptional<Date>;
  declare updated_at: CreationOptional<Date>;
  declare created_by: string | null;
  declare updated_by: string | null;

  declare organization?: NonAttribute<Organization>;
}

export type VenueRow = InferAttributes<Venue>;

Venue.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    organization_id: { type: DataTypes.UUID, allowNull: false },
    name: { type: DataTypes.STRING(255), allowNull: false },
    address: { type: DataTypes.STRING(500), allowNull: true },
    city: { type: DataTypes.STRING(120), allowNull: true },
    country: { type: DataTypes.STRING(2), allowNull: true },
    capacity: { type: DataTypes.INTEGER, allowNull: true },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
    created_by: { type: DataTypes.UUID, allowNull: true },
    updated_by: { type: DataTypes.UUID, allowNull: true },
  },
  { sequelize, modelName: "Venue", tableName: "venue" },
);
