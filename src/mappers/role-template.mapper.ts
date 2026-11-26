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
  /** Modules a role made from it gives at least one action on (Phase 2e). */
  grant_count: number;
  grants: Array<{
    module_code: string;
    module_name: string;
    view: boolean;
    create: boolean;
    update: boolean;
    delete: boolean;
    import: boolean;
    export: boolean;
    notify: boolean;
  }>;
};

export function toRoleTemplateDto(template: RoleTemplateRow, grants: RoleTemplateGrantRow[], lockedCode: string): RoleTemplateDto {
  const own = grants.filter((grant) => grant.role_template_id === template.id);
  return {
    id: template.id,
    code: template.code,
    name: template.name,
    description: template.description,
    is_active: template.is_active,
    for_new_organizations: template.for_new_organizations,
    locked: template.code === lockedCode,
    grant_count: own.filter(
      (grant) => grant.can_view || grant.can_create || grant.can_update || grant.can_delete || grant.can_import || grant.can_export || grant.can_notify,
    ).length,
    grants: own.map((grant) => ({
        module_code: grant.module.code,
        module_name: grant.module.module_name,
        view: grant.can_view,
        create: grant.can_create,
        update: grant.can_update,
        delete: grant.can_delete,
        import: grant.can_import,
        export: grant.can_export,
        notify: grant.can_notify,
      })),
  };
}
