import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from "sequelize";
import { sequelize } from "../db.js";

/**
 * A module is both a permission subject (is_permission) and a navigation node (is_menu).
 * Containers (is_permission = false) group menu items and never receive access rows.
 *
 * Named `AppModule` (table `module`) because a bare `Module` is easily confused with Node's own module system.
 */
export class AppModule extends Model<InferAttributes<AppModule>, InferCreationAttributes<AppModule>> {
  declare id: CreationOptional<string>;
  declare code: string;
  declare module_name: string;
  declare description: string | null;
  declare parent_id: string | null;
  declare sno: CreationOptional<number>;
  declare icon: string | null;
  declare route_name: string | null;
  declare is_menu: CreationOptional<boolean>;
  declare is_permission: CreationOptional<boolean>;
  declare is_active: CreationOptional<boolean>;
  declare created_at: CreationOptional<Date>;
  declare updated_at: CreationOptional<Date>;
  declare created_by: string | null;
  declare updated_by: string | null;
}

export type ModuleRow = InferAttributes<AppModule>;

AppModule.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    code: { type: DataTypes.STRING(80), allowNull: false },
    module_name: { type: DataTypes.STRING(250), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    parent_id: { type: DataTypes.UUID, allowNull: true },
    sno: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    icon: { type: DataTypes.STRING(250), allowNull: true },
    route_name: { type: DataTypes.STRING(250), allowNull: true },
    is_menu: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    is_permission: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
    created_by: { type: DataTypes.UUID, allowNull: true },
    updated_by: { type: DataTypes.UUID, allowNull: true },
  },
  { sequelize, modelName: "AppModule", tableName: "module" },
);
