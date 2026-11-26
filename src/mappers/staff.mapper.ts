import type { CentralUser } from "../clients/central-auth.client.js";
import type { RoleRow } from "../models/role.js";
import type { RoleGrantRow } from "../repositories/role-module-access.repository.js";
import type { StaffAssignmentRow } from "../repositories/user-role.repository.js";

/** A role and what it may do, module by module (read only in Phase 2b). */
export type RoleDto = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  is_active: boolean;
  /** Modules this role gives at least one action on (Phase 2e). */
  grant_count: number;
  /** Active staff assignments holding this role (Phase 2e). */
  member_count: number;
  /** The template the role was made from (Phase 2e); a copy, so later template edits don't change the role. */
  role_template: { id: string; code: string; name: string } | null;
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

const givesAnything = (grant: RoleGrantRow): boolean =>
  grant.can_view || grant.can_create || grant.can_update || grant.can_delete || grant.can_import || grant.can_export || grant.can_notify;

export type RoleTemplateRef = { id: string; code: string; name: string };

export function toRoleDto(role: RoleRow, grants: RoleGrantRow[], memberCount = 0, template: RoleTemplateRef | null = null): RoleDto {
  const own = grants.filter((grant) => grant.role_id === role.id);
  return {
    id: role.id,
    code: role.code,
    name: role.name,
    description: role.description,
    is_active: role.is_active,
    grant_count: own.filter(givesAnything).length,
    member_count: memberCount,
    role_template: template ? { id: template.id, code: template.code, name: template.name } : null,
    grants: own
      .map((grant) => ({
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

/** The person's name and mobile from auth-cheche (null when it couldn't be read). Never stored here. */
export type StaffProfileDto = { firstname: string | null; middlename: string | null; lastname: string | null; mobile: string | null } | null;

export type StaffAssignmentDto = {
  id: string;
  user_id: string;
  is_active: boolean;
  role: { id: string; code: string; name: string };
  branch: { id: string; code: string; name: string } | null;
  profile: StaffProfileDto;
  created_at: Date;
  updated_at: Date;
};

export function toStaffProfileDto(user: CentralUser | undefined): StaffProfileDto {
  return user ? { firstname: user.firstname, middlename: user.middlename, lastname: user.lastname, mobile: user.mobile } : null;
}

export function toStaffAssignmentDto(row: StaffAssignmentRow, user: CentralUser | undefined): StaffAssignmentDto {
  return {
    id: row.id,
    user_id: row.user_id,
    is_active: row.is_active,
    role: { id: row.role.id, code: row.role.code, name: row.role.name },
    branch: row.branch ? { id: row.branch.id, code: row.branch.code, name: row.branch.name } : null,
    profile: toStaffProfileDto(user),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
