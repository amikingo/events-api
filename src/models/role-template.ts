import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from "sequelize";
import { sequelize } from "../db.js";

/**
 * A platform role template (Phase 2d). New organizations get roles copied from the active templates marked
 * `for_new_organizations`; Owners can start a role from any active one. A copy, never a link.
 */
export class RoleTemplate extends Model<InferAttributes<RoleTemplate>, InferCreationAttributes<RoleTemplate>> {
  declare id: CreationOptional<string>;
  declare code: string;
  declare name: string;
  declare description: string | null;
  declare is_active: CreationOptional<boolean>;
  declare for_new_organizations: CreationOptional<boolean>;
  declare created_at: CreationOptional<Date>;
  declare updated_at: CreationOptional<Date>;
  declare created_by: string | null;
  declare updated_by: string | null;
}

export type RoleTemplateRow = InferAttributes<RoleTemplate>;

RoleTemplate.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    code: { type: DataTypes.STRING(80), allowNull: false },
    name: { type: DataTypes.STRING(250), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    for_new_organizations: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
    created_by: { type: DataTypes.UUID, allowNull: true },
    updated_by: { type: DataTypes.UUID, allowNull: true },
  },
  { sequelize, modelName: "RoleTemplate", tableName: "role_template" },
);
