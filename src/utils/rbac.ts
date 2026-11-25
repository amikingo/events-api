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
 * The actions a role can be given in the app: view, create and update (Phase 2c), plus export (Phase 4d: the guest
 * list as CSV). The API uses no delete, import or notify actions.
 */
export const GRANTABLE_ACTIONS = ["view", "create", "update", "export"] as const;
export type GrantableAction = (typeof GRANTABLE_ACTIONS)[number];

/**
 * What a tenant (organization) role may be granted, module by module (decided 25 November 2026). Anything else is
 * refused, so a tenant can never store platform powers in its own roles:
 * - ORGANIZATIONS: view and update only; creating tenants is platform work;
 * - MODULES, ROLE_TEMPLATES, USER_MODULE_ACCESSES: platform modules, never grantable to a tenant role;
 * - export only on REGISTRATIONS (the guest list CSV, its own right since it holds every guest's mobile).
 * Keyed by module code (utils/module-codes.ts).
 */
export const TENANT_GRANTABLE: Readonly<Record<string, readonly GrantableAction[]>> = Object.freeze({
  ORGANIZATIONS: ["view", "update"],
  BRANCHES: ["view", "create", "update"],
  ROLES: ["view", "create", "update"],
  USER_ROLES: ["view", "create", "update"],
  EVENTS: ["view", "create", "update"],
  CUSTOMERS: ["view", "create", "update"],
  REGISTRATIONS: ["view", "create", "update", "export"],
});
