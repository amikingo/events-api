import { toRoleDto, type RoleDto } from "../mappers/staff.mapper.js";
import { roleModuleAccessRepository } from "../repositories/role-module-access.repository.js";
import { roleRepository } from "../repositories/role.repository.js";
import { ensureFound } from "./helpers.js";

/** The organization's roles and what each may do (read only for now; custom roles come later). */
async function listRoles(organizationId: string): Promise<RoleDto[]> {
  const roles = await roleRepository.listByOrganization(organizationId);
  const grants = await roleModuleAccessRepository.listWithModulesByRoleIds(roles.map((role) => role.id));
  return roles.map((role) => toRoleDto(role, grants));
}

async function getRole(organizationId: string, roleId: string): Promise<RoleDto> {
  const role = ensureFound(await roleRepository.findByOrganizationAndId(organizationId, roleId), "Role not found");
  return toRoleDto(role, await roleModuleAccessRepository.listWithModulesByRoleIds([role.id]));
}

export const roleService = { listRoles, getRole };
