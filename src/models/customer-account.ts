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

export const CUSTOMER_ACCOUNT_KINDS = ["ORGANIZATION", "INDIVIDUAL"] as const;
export type CustomerAccountKind = (typeof CUSTOMER_ACCOUNT_KINDS)[number];

/**
 * The client commissioning an event (spec §3): an organization or an individual. Not an attendee; attendees are
 * `person` (Phase 4). `type` is an organizational client's sector and is always empty for an individual.
 */
export class CustomerAccount extends Model<InferAttributes<CustomerAccount>, InferCreationAttributes<CustomerAccount>> {
  declare id: CreationOptional<string>;
  declare organization_id: string;
  declare name: string;
  declare kind: CreationOptional<CustomerAccountKind>;
  declare type: string | null;
  declare primary_contact_name: string | null;
  declare primary_contact_email: string | null;
  declare primary_contact_phone: string | null;
  declare is_active: CreationOptional<boolean>;
  declare created_at: CreationOptional<Date>;
  declare updated_at: CreationOptional<Date>;
  declare created_by: string | null;
  declare updated_by: string | null;

  declare organization?: NonAttribute<Organization>;
}

export type CustomerAccountRow = InferAttributes<CustomerAccount>;

CustomerAccount.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    organization_id: { type: DataTypes.UUID, allowNull: false },
    name: { type: DataTypes.STRING(255), allowNull: false },
    kind: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "ORGANIZATION" },
    type: { type: DataTypes.STRING(80), allowNull: true },
    primary_contact_name: { type: DataTypes.STRING(255), allowNull: true },
    primary_contact_email: { type: DataTypes.STRING(254), allowNull: true },
    primary_contact_phone: { type: DataTypes.STRING(32), allowNull: true },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
    created_by: { type: DataTypes.UUID, allowNull: true },
    updated_by: { type: DataTypes.UUID, allowNull: true },
  },
  { sequelize, modelName: "CustomerAccount", tableName: "customer_account" },
);
