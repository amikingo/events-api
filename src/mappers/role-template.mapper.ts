import type { RoleTemplateRow } from "../models/role-template.js";
import type { RoleTemplateGrantRow } from "../repositories/role-template.repository.js";

/** A role template and what a role made from it may do, module by module (Phase 2d). Same grant shape as a role. */
export type RoleTemplateDto = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  is_active: boolean;
  for_new_organizations: boolean;
  /** The built-in OWNER template: can't be edited or switched off, always used for new organizations. */
  locked: boolean;
  grants: Array<{ module_code: string; module_name: string; view: boolean; create: boolean; update: boolean; export: boolean }>;
};

export function toRoleTemplateDto(template: RoleTemplateRow, grants: RoleTemplateGrantRow[], lockedCode: string): RoleTemplateDto {
  return {
    id: template.id,
    code: template.code,
    name: template.name,
    description: template.description,
    is_active: template.is_active,
    for_new_organizations: template.for_new_organizations,
    locked: template.code === lockedCode,
    grants: grants
      .filter((grant) => grant.role_template_id === template.id)
      .map((grant) => ({
        module_code: grant.module.code,
        module_name: grant.module.module_name,
        view: grant.can_view,
        create: grant.can_create,
        update: grant.can_update,
        export: grant.can_export,
      })),
  };
}
