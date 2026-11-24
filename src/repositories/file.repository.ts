import { StoredFile } from "../models/index.js";
import type { StoredFileRow } from "../models/stored-file.js";
import { toPlain } from "../utils/sequelize.js";
import { txOptions, type RepoOptions } from "./helpers.js";

/** Explicit projection: never `SELECT *`. Writes arrive with uploading in Phase 3d. */
const attributes = [
  "id",
  "organization_id",
  "purpose",
  "storage_key",
  "content_type",
  "size_bytes",
  "original_name",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
] as const satisfies readonly (keyof StoredFileRow)[];

// Keyed by organization_id + id. An id alone is never a tenant boundary.
async function findByOrganizationAndId(organizationId: string, fileId: string, options: RepoOptions = {}): Promise<StoredFileRow | null> {
  const row = await StoredFile.findOne({ where: { organization_id: organizationId, id: fileId }, attributes: [...attributes], ...txOptions(options) });
  return toPlain<StoredFileRow>(row);
}

export const fileRepository = { findByOrganizationAndId };
