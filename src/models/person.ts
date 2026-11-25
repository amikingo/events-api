import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../db.js";

/**
 * An organizer's reusable attendee profile (spec §6). A public guest always gets a new, unlinked profile; staff may
 * select an existing one after confirming the guest's identity. `user_id` links a Central Auth account (attendees
 * registering themselves, a later phase).
 */
export class Person extends Model<InferAttributes<Person>, InferCreationAttributes<Person>> {
  declare id: CreationOptional<string>;
  declare organization_id: string;
  declare first_name: string;
  declare last_name: string | null;
  declare email: string | null;
  /** Ethiopian mobiles are stored as +251…; other numbers as typed. */
  declare phone: string | null;
  declare affiliation_name: string | null;
  declare country: string | null;
  declare is_active: CreationOptional<boolean>;
  declare user_id: string | null;
  declare created_at: CreationOptional<Date>;
  declare updated_at: CreationOptional<Date>;
  declare created_by: string | null;
  declare updated_by: string | null;
}

export type PersonRow = InferAttributes<Person>;

Person.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    organization_id: { type: DataTypes.UUID, allowNull: false },
    first_name: { type: DataTypes.STRING(100), allowNull: false },
    last_name: { type: DataTypes.STRING(100), allowNull: true },
    email: { type: DataTypes.STRING(254), allowNull: true },
    phone: { type: DataTypes.STRING(32), allowNull: true },
    affiliation_name: { type: DataTypes.STRING(200), allowNull: true },
    country: { type: DataTypes.STRING(2), allowNull: true },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    user_id: { type: DataTypes.UUID, allowNull: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
    created_by: { type: DataTypes.UUID, allowNull: true },
    updated_by: { type: DataTypes.UUID, allowNull: true },
  },
  { sequelize, modelName: "Person", tableName: "person" },
);
