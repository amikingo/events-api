import { MODULE_CODES, type ModuleCode } from "./module-codes.js";
import type { PermissionAction } from "./rbac.js";

export type DefaultRoleTemplate = {
  code: string;
  name: string;
  description: string;
  grants: ReadonlyArray<{ moduleCode: ModuleCode; actions: readonly PermissionAction[] }>;
};

export const OWNER_ROLE_CODE = "OWNER";
export const VIEWER_ROLE_CODE = "VIEWER";

/**
 * The roles every new organization starts with (created by provisionOrganizer). Existing module codes only:
 * later phases add their modules here and extend existing organizations through migrations (EVENTS and CUSTOMERS:
 * 20261125000003-grant-events-and-customers-to-default-roles). No delete action: records are deactivated instead.
 * Never grant a platform-only module (MODULES, ROLE_TEMPLATES) to a tenant role.
 */
export const DEFAULT_TENANT_ROLES = [
  {
    code: OWNER_ROLE_CODE,
    name: "Owner",
    description: "Runs the organization",
    grants: [
      { moduleCode: MODULE_CODES.ORGANIZATIONS, actions: ["view", "update"] },
      { moduleCode: MODULE_CODES.BRANCHES, actions: ["view", "create", "update"] },
      { moduleCode: MODULE_CODES.ROLES, actions: ["view"] },
      { moduleCode: MODULE_CODES.USER_ROLES, actions: ["view"] },
      { moduleCode: MODULE_CODES.EVENTS, actions: ["view", "create", "update"] },
      { moduleCode: MODULE_CODES.CUSTOMERS, actions: ["view", "create", "update"] },
    ],
  },
  {
    code: VIEWER_ROLE_CODE,
    name: "Viewer",
    description: "Read-only access",
    grants: [
      { moduleCode: MODULE_CODES.ORGANIZATIONS, actions: ["view"] },
      { moduleCode: MODULE_CODES.BRANCHES, actions: ["view"] },
      { moduleCode: MODULE_CODES.EVENTS, actions: ["view"] },
      { moduleCode: MODULE_CODES.CUSTOMERS, actions: ["view"] },
    ],
  },
] as const satisfies readonly DefaultRoleTemplate[];
