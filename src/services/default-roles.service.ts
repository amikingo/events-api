import type { Transaction } from "sequelize";
import type { RoleRow } from "../models/role.js";
import { moduleRepository } from "../repositories/module.repository.js";
import { roleModuleAccessRepository } from "../repositories/role-module-access.repository.js";
import { roleRepository } from "../repositories/role.repository.js";
import type { PermissionAction, PermissionField } from "../utils/rbac.js";
import { roleTemplateService } from "./role-template.service.js";

/**
 * The roles every organization starts with, created in the caller's transaction. Since Phase 2d they are copied from
 * the active role templates marked for new organizations (OWNER and VIEWER at first); without an OWNER template the
 * code's DEFAULT_TENANT_ROLES are used instead. Used by every way an organization is created: POST
 * /v1/organizations and the provision:organizer script, so both make identical organizations.
 */
function permissionFlags(actions: readonly PermissionAction[]): Record<PermissionField, boolean> {
  return {
    can_view: actions.includes("view"),
    can_create: actions.includes("create"),
    can_update: actions.includes("update"),
    can_delete: actions.includes("delete"),
    can_import: actions.includes("import"),
    can_export: actions.includes("export"),
    can_notify: actions.includes("notify"),
  };
}

async function createDefaultRoles(organizationId: string, actorId: string | null, transaction: Transaction): Promise<Map<string, RoleRow>> {
  const modules = await moduleRepository.listActiveOrdered({ transaction });
  const moduleIdByCode = new Map(modules.filter((row) => row.is_permission).map((row) => [row.code, row.id]));

  const roles = new Map<string, RoleRow>();
  for (const template of await roleTemplateService.templatesForNewOrganization(transaction)) {
    const role = await roleRepository.create(
      {
        organization_id: organizationId,
        code: template.code,
        name: template.name,
        description: template.description,
        is_active: true,
        created_by: actorId,
        updated_by: actorId,
      },
      { transaction },
    );
    const grants = template.grants.map((grant) => {
      const moduleId = moduleIdByCode.get(grant.moduleCode);
      if (!moduleId) throw new Error(`Module ${String(grant.moduleCode)} is not seeded; run the migrations first`);
      return { role_id: role.id, module_id: moduleId, ...permissionFlags(grant.actions), created_by: actorId, updated_by: actorId };
    });
    await roleModuleAccessRepository.bulkCreate(grants, { transaction });
    roles.set(template.code, role);
  }
  return roles;
}

export const defaultRolesService = { createDefaultRoles };
