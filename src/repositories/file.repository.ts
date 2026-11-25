import { Op, type CreationAttributes } from "sequelize";
import { StoredFile } from "../models/index.js";
import type { StoredFileRow } from "../models/stored-file.js";
import { toPlain, toPlainList } from "../utils/sequelize.js";
import { txOptions, type RepoOptions, type WriteOptions } from "./helpers.js";

/** Explicit projection: never `SELECT *`. */
const attributes = [
  "id",
  "organization_id",
  "purpose",
  "entity_type",
  "entity_id",
  "storage_provider",
  "storage_key",
  "content_type",
  "size_bytes",
  "original_name",
  "uploaded_by",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
] as const satisfies readonly (keyof StoredFileRow)[];

async function create(values: CreationAttributes<StoredFile>, options: WriteOptions = {}): Promise<StoredFileRow> {
  const row = await StoredFile.create(values, txOptions(options));
  return row.get({ plain: true });
}

// Keyed by organization_id + id. An id alone is never a tenant boundary.
async function findByOrganizationAndId(organizationId: string, fileId: string, options: RepoOptions = {}): Promise<StoredFileRow | null> {
  const row = await StoredFile.findOne({ where: { organization_id: organizationId, id: fileId }, attributes: [...attributes], ...txOptions(options) });
  return toPlain<StoredFileRow>(row);
}

/** One query for several files of the organization (e.g. the covers of a page of events). */
async function listByOrganizationAndIds(organizationId: string, fileIds: readonly string[], options: RepoOptions = {}): Promise<StoredFileRow[]> {
  if (fileIds.length === 0) return [];
  const rows = await StoredFile.findAll({
    where: { organization_id: organizationId, id: { [Op.in]: [...fileIds] } },
    attributes: [...attributes],
    ...txOptions(options),
  });
  return toPlainList<StoredFileRow>(rows);
}

export const fileRepository = { create, findByOrganizationAndId, listByOrganizationAndIds };
