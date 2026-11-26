import type { CreationAttributes } from "sequelize";
import { SubmissionKey } from "../models/index.js";
import type { SubmissionKeyRow, SubmissionScope } from "../models/submission-key.js";
import { toPlain } from "../utils/sequelize.js";
import { txOptions, type RepoOptions, type WriteOptions } from "./helpers.js";

const attributes = ["id", "organization_id", "scope", "key", "request_hash", "registration_id", "order_id", "created_at", "updated_at"] as const satisfies readonly (keyof SubmissionKeyRow)[];

/** Keyed by organization + scope + key (uq_submission_key_organization_scope_key). */
async function findByScopeAndKey(
  organizationId: string,
  scope: SubmissionScope,
  key: string,
  options: RepoOptions = {},
): Promise<SubmissionKeyRow | null> {
  const row = await SubmissionKey.findOne({ where: { organization_id: organizationId, scope, key }, attributes: [...attributes], ...txOptions(options) });
  return toPlain<SubmissionKeyRow>(row);
}

async function create(values: CreationAttributes<SubmissionKey>, options: WriteOptions = {}): Promise<SubmissionKeyRow> {
  const row = await SubmissionKey.create(values, txOptions(options));
  return row.get({ plain: true });
}

export const submissionKeyRepository = { findByScopeAndKey, create };
