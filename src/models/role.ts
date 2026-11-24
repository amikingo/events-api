import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from "sequelize";
import { sequelize } from "../db.js";

/** organization_id = null marks a platform role (e.g. SUPER_ADMIN); otherwise a tenant role. */
export class Role extends Model<InferAttributes<Role>, InferCreationAttributes<Role>> {
  declare id: CreationOptional<string>;
  declare organization_id: string | null;
  declare code: string;
  declare name: string;
  declare description: string | null;
  declare is_active: CreationOptional<boolean>;
  declare created_at: CreationOptional<Date>;
  declare updated_at: CreationOptional<Date>;
  declare created_by: string | null;
  declare updated_by: string | null;
}

export type RoleRow = InferAttributes<Role>;

Role.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    organization_id: { type: DataTypes.UUID, allowNull: true },
    code: { type: DataTypes.STRING(80), allowNull: false },
    name: { type: DataTypes.STRING(250), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
    created_by: { type: DataTypes.UUID, allowNull: true },
    updated_by: { type: DataTypes.UUID, allowNull: true },
  },
  { sequelize, modelName: "Role", tableName: "role" },
);
