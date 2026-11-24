import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../db.js";

export const FILE_PURPOSES = ["EVENT_COVER"] as const;
export type FilePurpose = (typeof FILE_PURPOSES)[number];

/**
 * Tenant-scoped metadata for a stored file (table `file`). Named `StoredFile` because a bare `File` would shadow
 * the runtime's global File class. Uploading and storage arrive in Phase 3d.
 */
export class StoredFile extends Model<InferAttributes<StoredFile>, InferCreationAttributes<StoredFile>> {
  declare id: CreationOptional<string>;
  declare organization_id: string;
  declare purpose: FilePurpose;
  declare storage_key: string;
  declare content_type: string;
  declare size_bytes: number;
  declare original_name: string | null;
  declare created_at: CreationOptional<Date>;
  declare updated_at: CreationOptional<Date>;
  declare created_by: string | null;
  declare updated_by: string | null;
}

export type StoredFileRow = InferAttributes<StoredFile>;

StoredFile.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    organization_id: { type: DataTypes.UUID, allowNull: false },
    purpose: { type: DataTypes.STRING(40), allowNull: false },
    storage_key: { type: DataTypes.STRING(500), allowNull: false },
    content_type: { type: DataTypes.STRING(100), allowNull: false },
    size_bytes: { type: DataTypes.INTEGER, allowNull: false },
    original_name: { type: DataTypes.STRING(255), allowNull: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
    created_by: { type: DataTypes.UUID, allowNull: true },
    updated_by: { type: DataTypes.UUID, allowNull: true },
  },
  { sequelize, modelName: "StoredFile", tableName: "file" },
);
