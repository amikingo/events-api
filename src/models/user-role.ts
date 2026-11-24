import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
} from "sequelize";
import { sequelize } from "../db.js";
import type { Branch } from "./branch.js";
import type { Organization } from "./organization.js";
import type { Role } from "./role.js";

/**
 * A staff "assignment": external identity (user_id from Central Auth, no local FK)
 * + role + scope. organization_id = null => platform assignment.
 * branch_id != null => branch-scoped assignment inside organization_id.
 */
export class UserRole extends Model<InferAttributes<UserRole>, InferCreationAttributes<UserRole>> {
  declare id: CreationOptional<string>;
  declare user_id: string;
  declare role_id: string;
  declare organization_id: string | null;
  declare branch_id: string | null;
  declare is_active: CreationOptional<boolean>;
  declare created_at: CreationOptional<Date>;
  declare updated_at: CreationOptional<Date>;
  declare created_by: string | null;
  declare updated_by: string | null;

  declare role?: NonAttribute<Role>;
  declare organization?: NonAttribute<Organization | null>;
  declare branch?: NonAttribute<Branch | null>;
}

export type UserRoleRow = InferAttributes<UserRole>;

UserRole.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    user_id: { type: DataTypes.UUID, allowNull: false },
    role_id: { type: DataTypes.UUID, allowNull: false },
    organization_id: { type: DataTypes.UUID, allowNull: true },
    branch_id: { type: DataTypes.UUID, allowNull: true },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
    created_by: { type: DataTypes.UUID, allowNull: true },
    updated_by: { type: DataTypes.UUID, allowNull: true },
  },
  { sequelize, modelName: "UserRole", tableName: "user_role" },
);
