import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from "sequelize";
import { sequelize } from "../db.js";

export class Organization extends Model<InferAttributes<Organization>, InferCreationAttributes<Organization>> {
  declare id: CreationOptional<string>;
  declare name: string;
  declare slug: string;
  declare description: string | null;
  /** false: a hidden MAIN branch exists, and staff never see branches. */
  declare has_branches: CreationOptional<boolean>;
  /** Defaults for new records: ISO country code, IANA time zone, ISO currency code. */
  declare country: CreationOptional<string>;
  declare timezone: CreationOptional<string>;
  declare default_currency: CreationOptional<string>;
  declare is_active: CreationOptional<boolean>;
  declare created_at: CreationOptional<Date>;
  declare updated_at: CreationOptional<Date>;
  declare created_by: string | null;
  declare updated_by: string | null;
}

export type OrganizationRow = InferAttributes<Organization>;

Organization.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    name: { type: DataTypes.STRING(255), allowNull: false },
    slug: { type: DataTypes.STRING(120), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    has_branches: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    country: { type: DataTypes.STRING(2), allowNull: false, defaultValue: "ET" },
    timezone: { type: DataTypes.STRING(64), allowNull: false, defaultValue: "Africa/Addis_Ababa" },
    default_currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: "ETB" },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
    created_by: { type: DataTypes.UUID, allowNull: true },
    updated_by: { type: DataTypes.UUID, allowNull: true },
  },
  { sequelize, modelName: "Organization", tableName: "organization" },
);
