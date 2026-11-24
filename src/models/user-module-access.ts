import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from "sequelize";
import { sequelize } from "../db.js";

/**
 * Per-assignment override. null = "inherit from role", true/false = explicit override.
 * A CHECK constraint requires at least one non-null flag.
 */
export class UserModuleAccess extends Model<
  InferAttributes<UserModuleAccess>,
  InferCreationAttributes<UserModuleAccess>
> {
  declare id: CreationOptional<string>;
  declare user_role_id: string;
  declare module_id: string;
  declare can_view: boolean | null;
  declare can_create: boolean | null;
  declare can_update: boolean | null;
  declare can_delete: boolean | null;
  declare can_import: boolean | null;
  declare can_export: boolean | null;
  declare can_notify: boolean | null;
  declare is_active: CreationOptional<boolean>;
  declare created_at: CreationOptional<Date>;
  declare updated_at: CreationOptional<Date>;
  declare created_by: string | null;
  declare updated_by: string | null;
}

export type UserModuleAccessRow = InferAttributes<UserModuleAccess>;

// A factory, not a shared object: Sequelize mutates attribute definitions during init().
const overrideFlag = () => ({ type: DataTypes.BOOLEAN, allowNull: true });

UserModuleAccess.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    user_role_id: { type: DataTypes.UUID, allowNull: false },
    module_id: { type: DataTypes.UUID, allowNull: false },
    can_view: overrideFlag(),
    can_create: overrideFlag(),
    can_update: overrideFlag(),
    can_delete: overrideFlag(),
    can_import: overrideFlag(),
    can_export: overrideFlag(),
    can_notify: overrideFlag(),
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
    created_by: { type: DataTypes.UUID, allowNull: true },
    updated_by: { type: DataTypes.UUID, allowNull: true },
  },
  { sequelize, modelName: "UserModuleAccess", tableName: "user_module_access" },
);
