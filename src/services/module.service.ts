import type { Transaction } from "sequelize";
import { ConflictError, InvalidModuleStateError, ModuleInUseError, ModuleProtectedError, ValidationAppError } from "../errors/app-errors.js";
import type { ModuleRow } from "../models/module.js";
import { moduleRepository } from "../repositories/module.repository.js";
import { roleModuleAccessRepository } from "../repositories/role-module-access.repository.js";
import { roleTemplateRepository } from "../repositories/role-template.repository.js";
import { userModuleAccessRepository } from "../repositories/user-module-access.repository.js";
import { MODULE_CODES } from "../utils/module-codes.js";
import type { ModuleCreateInput, ModuleUpdateInput } from "../validators/module.js";
import { ensureFound, runTransaction } from "./helpers.js";

/**
 * Modules (Phase 2d, extended in Phase 2e on 26 November 2026): the platform's menu and permission list, managed at
 * platform scope (the Super Admin). `/me` reads the changes on the next request. Rules:
 * - **Display fields** (name, description, order, icon) always change freely.
 * - **Core modules** are the ones the code checks (MODULE_CODES). Their route and permission flag are fixed, because
 *   the code and the web app depend on them (409 module_protected). Their parent and menu flag may change.
 * - **Always on:** Modules, Role Templates, Organizations, Roles and Staff Assignments can't be switched off, or the
 *   admin screens would lock themselves out (409 module_protected).
 * - **The tree:** a parent must exist and be switched on, and a module can't sit under itself or its own submodules
 *   (400). A module with switched-on submodules can't be switched off, and one under a switched-off parent can't be
 *   switched on (409 invalid_module_state), so nothing floats loose in the menu.
 * - **Grants:** a module stops being a permission module only when no role, template or override grants it
 *   (409 module_in_use).
 * - **Switched off:** nobody can use the module, the Super Admin included (`module_unavailable`), and it leaves every
 *   menu. Its grants are kept for when it is switched back on.
 * - **New modules** are menu groups, links, or permission modules for platform roles. They are never grantable to an
 *   organization: TENANT_GRANTABLE stays in code, because only code can make a module mean something.
 * Every change takes the module-tree lock, so two moves at the same moment can't build a loop.
 */
export type ModuleNodeDto = Pick<
  ModuleRow,
  "id" | "code" | "module_name" | "description" | "parent_id" | "sno" | "icon" | "route_name" | "is_menu" | "is_permission" | "is_active"
> & {
  /** A module the code checks: its route and permission flag can't change. */
  is_core: boolean;
  /** A module the admin screens need: it can't be switched off. */
  always_on: boolean;
  children: ModuleNodeDto[];
};

const CORE_CODES: ReadonlySet<string> = new Set(Object.values(MODULE_CODES));
const ALWAYS_ON_CODES: ReadonlySet<string> = new Set([
  MODULE_CODES.MODULES,
  MODULE_CODES.ROLE_TEMPLATES,
  MODULE_CODES.ORGANIZATIONS,
  MODULE_CODES.ROLES,
  MODULE_CODES.USER_ROLES,
]);

function toNode(row: ModuleRow): ModuleNodeDto {
  return {
    id: row.id,
    code: row.code,
    module_name: row.module_name,
    description: row.description,
    parent_id: row.parent_id,
    sno: row.sno,
    icon: row.icon,
    route_name: row.route_name,
    is_menu: row.is_menu,
    is_permission: row.is_permission,
    is_active: row.is_active,
    is_core: CORE_CODES.has(row.code),
    always_on: ALWAYS_ON_CODES.has(row.code),
    children: [],
  };
}

/** Every module, as a tree in menu order (rows arrive sorted by sno, name, code). */
async function listModuleTree(): Promise<ModuleNodeDto[]> {
  const nodes = (await moduleRepository.listAllOrdered()).map(toNode);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const roots: ModuleNodeDto[] = [];
  for (const node of nodes) {
    const parent = node.parent_id ? byId.get(node.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function parentIssue(message: string, code: string): ValidationAppError {
  return new ValidationAppError("Request validation failed", { issues: [{ path: "body.parent_id", message, code }] });
}

/**
 * Takes the module-tree lock and returns every module by id. Call first in any change, so the checks below read the
 * tree as it is while this transaction runs.
 */
async function lockedTree(transaction: Transaction): Promise<Map<string, ModuleRow>> {
  await moduleRepository.lockTree({ transaction });
  return new Map((await moduleRepository.listAllOrdered({ transaction })).map((row) => [row.id, row]));
}

/** The new parent exists, is switched on, and isn't the module itself or one of its submodules (400 otherwise). */
function assertParent(moduleId: string | null, parentId: string, tree: Map<string, ModuleRow>): void {
  const parent = tree.get(parentId);
  if (!parent) throw parentIssue("No module has this id", "parent_not_found");
  if (!parent.is_active) throw parentIssue("This module is switched off; choose a switched-on parent", "parent_inactive");
  const seen = new Set<string>();
  for (let current: string | null = parentId; current && !seen.has(current); current = tree.get(current)?.parent_id ?? null) {
    if (current === moduleId) throw parentIssue("A module can't sit under itself or one of its own submodules", "parent_cycle");
    seen.add(current);
  }
}

async function grantCount(moduleId: string, transaction: Transaction): Promise<number> {
  const options = { transaction };
  const [roles, templates, overrides] = await Promise.all([
    roleModuleAccessRepository.countByModule(moduleId, options),
    roleTemplateRepository.countGrantsByModule(moduleId, options),
    userModuleAccessRepository.countByModule(moduleId, options),
  ]);
  return roles + templates + overrides;
}

/** A new menu group, link or permission module. The code is upper case, unique and fixed afterwards. */
async function createModule(input: ModuleCreateInput, actorId: string | null): Promise<ModuleNodeDto> {
  return runTransaction(async (transaction) => {
    const tree = await lockedTree(transaction);
    if (await moduleRepository.findByCode(input.code, { transaction })) {
      throw new ConflictError("Another module already uses this code", { field: "code" });
    }
    if (input.parent_id) assertParent(null, input.parent_id, tree);
    const created = await moduleRepository.create(
      {
        code: input.code,
        module_name: input.module_name,
        description: input.description ?? null,
        parent_id: input.parent_id ?? null,
        sno: input.sno ?? 0,
        icon: input.icon ?? null,
        route_name: input.route_name ?? null,
        is_menu: input.is_menu,
        is_permission: input.is_permission,
        is_active: true,
        created_by: actorId,
        updated_by: actorId,
      },
      { transaction },
    );
    return toNode(created);
  });
}

/** Display fields and structure. Core modules keep their route and permission flag; codes never change. */
async function updateModule(moduleId: string, input: ModuleUpdateInput, actorId: string | null): Promise<ModuleNodeDto> {
  return runTransaction(async (transaction) => {
    const tree = await lockedTree(transaction);
    const current = ensureFound(await moduleRepository.findById(moduleId, { transaction, lock: true }), "Module not found");

    if (CORE_CODES.has(current.code)) {
      if (input.route_name !== undefined && input.route_name !== current.route_name) {
        throw new ModuleProtectedError("The web app depends on this module's route, so it can't change", { field: "route_name" });
      }
      if (input.is_permission !== undefined && input.is_permission !== current.is_permission) {
        throw new ModuleProtectedError("The code checks this module, so it stays a permission module", { field: "is_permission" });
      }
    }
    if (input.parent_id && input.parent_id !== current.parent_id) assertParent(current.id, input.parent_id, tree);
    if (input.is_permission === false && current.is_permission) {
      const grants = await grantCount(current.id, transaction);
      if (grants > 0) throw new ModuleInUseError(undefined, { grants });
    }

    const updated = ensureFound(
      await moduleRepository.updateById(
        moduleId,
        {
          ...(input.module_name === undefined ? {} : { module_name: input.module_name }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.sno === undefined ? {} : { sno: input.sno }),
          ...(input.icon === undefined ? {} : { icon: input.icon }),
          ...(input.parent_id === undefined ? {} : { parent_id: input.parent_id }),
          ...(input.route_name === undefined ? {} : { route_name: input.route_name }),
          ...(input.is_menu === undefined ? {} : { is_menu: input.is_menu }),
          ...(input.is_permission === undefined ? {} : { is_permission: input.is_permission }),
          updated_by: actorId,
        },
        { transaction },
      ),
      "Module not found",
    );
    return toNode(updated);
  });
}

/**
 * Switch a module off (nobody can use it, the Super Admin included; it leaves every menu; grants are kept) or back
 * on. The current state again changes nothing.
 */
async function changeModuleStatus(moduleId: string, isActive: boolean, actorId: string | null): Promise<ModuleNodeDto> {
  return runTransaction(async (transaction) => {
    const tree = await lockedTree(transaction);
    const current = ensureFound(await moduleRepository.findById(moduleId, { transaction, lock: true }), "Module not found");
    if (current.is_active === isActive) return toNode(current);

    if (!isActive) {
      if (ALWAYS_ON_CODES.has(current.code)) {
        throw new ModuleProtectedError("The admin screens need this module, so it can't be switched off", { code: current.code });
      }
      const activeChildren = [...tree.values()].filter((row) => row.parent_id === current.id && row.is_active).length;
      if (activeChildren > 0) {
        throw new InvalidModuleStateError("Switch off or move its submodules first", { active_children: activeChildren });
      }
    } else {
      const parent = current.parent_id ? tree.get(current.parent_id) : undefined;
      if (parent && !parent.is_active) {
        throw new InvalidModuleStateError("Its parent is switched off. Switch the parent on first, or move this module", { parent_id: parent.id });
      }
    }

    const updated = ensureFound(await moduleRepository.updateById(moduleId, { is_active: isActive, updated_by: actorId }, { transaction }), "Module not found");
    return toNode(updated);
  });
}

export const moduleService = { listModuleTree, createModule, updateModule, changeModuleStatus };
