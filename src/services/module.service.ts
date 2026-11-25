import type { ModuleRow } from "../models/module.js";
import { moduleRepository } from "../repositories/module.repository.js";
import type { ModuleUpdateInput } from "../validators/module.js";
import { ensureFound, runTransaction } from "./helpers.js";

/**
 * Modules (Phase 2d, decided 25 November 2026): the platform's menu and permission list. The Super Admin sees every
 * module as a tree and may change the name, description, order and icon. `/me` reads them on the next request.
 */
export type ModuleNodeDto = Pick<
  ModuleRow,
  "id" | "code" | "module_name" | "description" | "parent_id" | "sno" | "icon" | "route_name" | "is_menu" | "is_permission" | "is_active"
> & { children: ModuleNodeDto[] };

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

async function updateModule(moduleId: string, input: ModuleUpdateInput, actorId: string | null): Promise<ModuleNodeDto> {
  return runTransaction(async (transaction) => {
    ensureFound(await moduleRepository.findById(moduleId, { transaction, lock: true }), "Module not found");
    const updated = ensureFound(
      await moduleRepository.updateDisplay(
        moduleId,
        {
          ...(input.module_name === undefined ? {} : { module_name: input.module_name }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.sno === undefined ? {} : { sno: input.sno }),
          ...(input.icon === undefined ? {} : { icon: input.icon }),
          updated_by: actorId,
        },
        { transaction },
      ),
      "Module not found",
    );
    return toNode(updated);
  });
}

export const moduleService = { listModuleTree, updateModule };
