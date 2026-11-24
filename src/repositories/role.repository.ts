import { Role } from "../models/index.js";
import type { RoleRow } from "../models/role.js";
import { toPlain } from "../utils/sequelize.js";
import { txOptions, type RepoOptions } from "./helpers.js";

const attributes = [
  "id",
  "organization_id",
  "code",
  "name",
  "description",
  "is_active",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
] as const satisfies readonly (keyof RoleRow)[];

async function findPlatformRoleByCode(code: string, options: RepoOptions = {}): Promise<RoleRow | null> {
  const row = await Role.findOne({ where: { organization_id: null, code }, attributes: [...attributes], ...txOptions(options) });
  return toPlain<RoleRow>(row);
}

export const roleRepository = { findPlatformRoleByCode };
