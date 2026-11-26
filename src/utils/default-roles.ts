import { MODULE_CODES, type ModuleCode } from "./module-codes.js";
import type { PermissionAction } from "./rbac.js";

export type DefaultRoleTemplate = {
  /** The role template this came from, when it came from the database (Phase 2e); the new role remembers it. */
  templateId?: string;
  code: string;
  name: string;
  description: string;
  grants: ReadonlyArray<{ moduleCode: ModuleCode; actions: readonly PermissionAction[] }>;
};

export const OWNER_ROLE_CODE = "OWNER";

const ALL_ACTIONS = ["view", "create", "update", "delete", "import", "export", "notify"] as const;
export const VIEWER_ROLE_CODE = "VIEWER";

/**
 * The roles every new organization starts with (created by provisionOrganizer). Existing module codes only:
 * later phases add their modules here and extend existing organizations through migrations (EVENTS and CUSTOMERS:
 * 20261125000003-grant-events-and-customers-to-default-roles; REGISTRATIONS: 20261126000004;
 * USER_ROLES create/update for OWNER: 20261127000000; ROLES create/update for OWNER: 20261128000000; REGISTRATIONS export
 * for OWNER: 20261129000000; all 7 actions for OWNER: 20261202000000 and, for the OWNER template, 20261202000001).
 * Never grant a platform-only module (MODULES, ROLE_TEMPLATES) to a tenant role.
 */
export const DEFAULT_TENANT_ROLES = [
  {
    code: OWNER_ROLE_CODE,
    name: "Owner",
    description: "Runs the organization",
    grants: [
      // Phase 2e: Owners hold every action a tenant may hold (TENANT_GRANTABLE), so they can grant all of them.
      { moduleCode: MODULE_CODES.ORGANIZATIONS, actions: ["view", "update", "import", "export", "notify"] },
      { moduleCode: MODULE_CODES.BRANCHES, actions: ALL_ACTIONS },
      { moduleCode: MODULE_CODES.ROLES, actions: ALL_ACTIONS },
      { moduleCode: MODULE_CODES.USER_ROLES, actions: ALL_ACTIONS },
      { moduleCode: MODULE_CODES.EVENTS, actions: ALL_ACTIONS },
      { moduleCode: MODULE_CODES.CUSTOMERS, actions: ALL_ACTIONS },
      { moduleCode: MODULE_CODES.REGISTRATIONS, actions: ALL_ACTIONS },
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
      { moduleCode: MODULE_CODES.REGISTRATIONS, actions: ["view"] },
    ],
  },
] as const satisfies readonly DefaultRoleTemplate[];
