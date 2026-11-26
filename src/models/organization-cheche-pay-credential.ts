import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../db.js";
import type { KeyMode } from "./order-payment.js";

/**
 * An organizer's Cheche Pay v2 merchant keys (Phase 7 step 3b), as bookings. The secret key and the optional webhook
 * secret are stored encrypted (utils/secret-box.ts); only the mode and the key's last 4 characters are plain. Never
 * returned by the API.
 */
export class OrganizationChechePayCredential extends Model<
  InferAttributes<OrganizationChechePayCredential>,
  InferCreationAttributes<OrganizationChechePayCredential>
> {
  declare id: CreationOptional<string>;
  declare organization_id: string;
  declare key_mode: KeyMode;
  declare secret_key_encrypted: string;
  declare secret_key_last4: string;
  declare webhook_secret_encrypted: string | null;
  declare is_active: CreationOptional<boolean>;
  declare created_at: CreationOptional<Date>;
  declare updated_at: CreationOptional<Date>;
  declare created_by: string | null;
  declare updated_by: string | null;
}

export type OrganizationChechePayCredentialRow = InferAttributes<OrganizationChechePayCredential>;

OrganizationChechePayCredential.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    organization_id: { type: DataTypes.UUID, allowNull: false },
    key_mode: { type: DataTypes.STRING(10), allowNull: false },
    secret_key_encrypted: { type: DataTypes.TEXT, allowNull: false },
    secret_key_last4: { type: DataTypes.STRING(4), allowNull: false },
    webhook_secret_encrypted: { type: DataTypes.TEXT, allowNull: true },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
    created_by: { type: DataTypes.UUID, allowNull: true },
    updated_by: { type: DataTypes.UUID, allowNull: true },
  },
  { sequelize, modelName: "OrganizationChechePayCredential", tableName: "organization_cheche_pay_credential" },
);
