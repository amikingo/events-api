import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from "sequelize";
import { sequelize } from "../db.js";

/** A role template's grant on one module (Phase 2d): the same flags as role_module_access. */
export class RoleTemplateModuleAccess extends Model<
  InferAttributes<RoleTemplateModuleAccess>,
  InferCreationAttributes<RoleTemplateModuleAccess>
> {
  declare id: CreationOptional<string>;
  declare role_template_id: string;
  declare module_id: string;
  declare can_view: CreationOptional<boolean>;
  declare can_create: CreationOptional<boolean>;
  declare can_update: CreationOptional<boolean>;
  declare can_delete: CreationOptional<boolean>;
  declare can_import: CreationOptional<boolean>;
  declare can_export: CreationOptional<boolean>;
  declare can_notify: CreationOptional<boolean>;
  declare created_at: CreationOptional<Date>;
  declare updated_at: CreationOptional<Date>;
  declare created_by: string | null;
  declare updated_by: string | null;
}

export type RoleTemplateModuleAccessRow = InferAttributes<RoleTemplateModuleAccess>;

// A factory, not a shared object: Sequelize mutates attribute definitions during init().
const permissionFlag = () => ({ type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });

RoleTemplateModuleAccess.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    role_template_id: { type: DataTypes.UUID, allowNull: false },
    module_id: { type: DataTypes.UUID, allowNull: false },
    can_view: permissionFlag(),
    can_create: permissionFlag(),
    can_update: permissionFlag(),
    can_delete: permissionFlag(),
    can_import: permissionFlag(),
    can_export: permissionFlag(),
    can_notify: permissionFlag(),
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
    created_by: { type: DataTypes.UUID, allowNull: true },
    updated_by: { type: DataTypes.UUID, allowNull: true },
  },
  { sequelize, modelName: "RoleTemplateModuleAccess", tableName: "role_template_module_access" },
);
