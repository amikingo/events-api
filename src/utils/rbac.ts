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
