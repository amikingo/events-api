import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../db.js";

export const FILE_PURPOSES = ["EVENT_COVER"] as const;
export type FilePurpose = (typeof FILE_PURPOSES)[number];
export type FileEntityType = "EVENT";

/**
 * Tenant-scoped metadata for a stored file (table `file`), like bookings_api's files table. Named `StoredFile`
 * because a bare `File` would shadow the runtime's global File class. The bytes live in the storage provider
 * (local disk under FILES_DIR today), at `storage_key` (e.g. events/covers/<uuid>.png).
 */
export class StoredFile extends Model<InferAttributes<StoredFile>, InferCreationAttributes<StoredFile>> {
  declare id: CreationOptional<string>;
  declare organization_id: string;
  declare purpose: FilePurpose;
  /** What the file belongs to (for EVENT_COVER: the event). */
  declare entity_type: FileEntityType | null;
  declare entity_id: string | null;
  declare storage_provider: CreationOptional<"local">;
  declare storage_key: string;
  declare content_type: string;
  declare size_bytes: number;
  /** Kept as metadata only; never used in the stored name or path. */
  declare original_name: string | null;
  /** The staff member who uploaded it (Central Auth user id). */
  declare uploaded_by: string | null;
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
    entity_type: { type: DataTypes.STRING(40), allowNull: true },
    entity_id: { type: DataTypes.UUID, allowNull: true },
    storage_provider: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "local" },
    storage_key: { type: DataTypes.STRING(500), allowNull: false },
    content_type: { type: DataTypes.STRING(100), allowNull: false },
    size_bytes: { type: DataTypes.INTEGER, allowNull: false },
    original_name: { type: DataTypes.STRING(255), allowNull: true },
    uploaded_by: { type: DataTypes.UUID, allowNull: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
    created_by: { type: DataTypes.UUID, allowNull: true },
    updated_by: { type: DataTypes.UUID, allowNull: true },
  },
  { sequelize, modelName: "StoredFile", tableName: "file" },
);
