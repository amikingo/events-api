export const PERMISSION_ACTIONS = ["view", "create", "update", "delete", "import", "export", "notify"] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

export const PERMISSION_FIELDS = [
  "can_view",
  "can_create",
  "can_update",
  "can_delete",
  "can_import",
  "can_export",
  "can_notify",
] as const;
export type PermissionField = (typeof PERMISSION_FIELDS)[number];

export const ACTION_TO_FIELD: Readonly<Record<PermissionAction, PermissionField>> = {
  view: "can_view",
  create: "can_create",
  update: "can_update",
  delete: "can_delete",
  import: "can_import",
  export: "can_export",
  notify: "can_notify",
};

export type PermissionMatrix = Record<PermissionAction, boolean>;

export const DENIED_PERMISSION: Readonly<PermissionMatrix> = Object.freeze({
  view: false,
  create: false,
  update: false,
  delete: false,
  import: false,
  export: false,
  notify: false,
});

export const FULL_PERMISSION: Readonly<PermissionMatrix> = Object.freeze({
  view: true,
  create: true,
  update: true,
  delete: true,
  import: true,
  export: true,
  notify: true,
});

export const SUPER_ADMIN_ROLE_CODE = "SUPER_ADMIN";

/**
 * The actions a role can be given in the app: all seven (Phase 2e, decided 26 November 2026). Earlier phases used
 * only view, create, update and export; delete, import and notify are grantable now and take effect where an
 * endpoint checks them (Staff Assignments › delete deletes an assignment).
 */
export const GRANTABLE_ACTIONS = PERMISSION_ACTIONS;
export type GrantableAction = PermissionAction;

/** Every action, for tenant modules that offer all of them. */
const ALL_ACTIONS: readonly GrantableAction[] = PERMISSION_ACTIONS;

/**
 * What a tenant (organization) role may be granted, module by module (Phase 2c, widened to all 7 actions in Phase 2e).
 * Anything else is refused, so a tenant can never store platform powers in its own roles:
 * - ORGANIZATIONS: never create or delete; making and removing organizations is platform work;
 * - MODULES, ROLE_TEMPLATES, USER_MODULE_ACCESSES: platform modules, never grantable to a tenant role.
 * Keyed by module code (utils/module-codes.ts).
 */
export const TENANT_GRANTABLE: Readonly<Record<string, readonly GrantableAction[]>> = Object.freeze({
  ORGANIZATIONS: ["view", "update", "import", "export", "notify"],
  BRANCHES: ALL_ACTIONS,
  ROLES: ALL_ACTIONS,
  USER_ROLES: ALL_ACTIONS,
  EVENTS: ALL_ACTIONS,
  CUSTOMERS: ALL_ACTIONS,
  REGISTRATIONS: ALL_ACTIONS,
});
