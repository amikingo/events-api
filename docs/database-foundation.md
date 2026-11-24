# Database Foundation

Conventions: singular snake_case tables (no prefix); UUID primary keys (`gen_random_uuid()` default,
`UUIDV4` in models); audit columns `created_at`, `updated_at` (`timestamptz`, default `now()`), `created_by`,
`updated_by`; soft status `is_active`; every constraint and index named; external Central Auth ids are logical
references without FKs.

## Migration order

1. `organization` 2. `branch` 3. `module` 4. `role` 5. `role_module_access`
6. `user_role` (+ `fn_user_role_scope_guard` trigger) 7. `user_module_access`
8. seed: platform modules + `SUPER_ADMIN` role

## Tables

### `organization`
- Constraints: `uq_organization_slug`, `ck_organization_slug_format`
- Indexes: `idx_organization_is_active`
- Triggers: none

### `branch`
- Constraints: `fk_branch_organization_id`, `uq_branch_organization_id_id` (tenant-safe composite key),
  `uq_branch_organization_id_code`, `ck_branch_code_format`,
  partial unique `uq_branch_organization_default_active` (one active default per organization)
- Indexes: `idx_branch_organization_active`
- Triggers: none

### `module`
- Constraints: `fk_module_parent_id` (SET NULL), `uq_module_code`, `ck_module_code_format`,
  `ck_module_parent_not_self`, `ck_module_sno_non_negative`
- Indexes: `idx_module_parent_id_sno`
- Triggers: none
- Cycles (A → B → A through `parent_id`) are **not** checked yet: the constraints only stop a module being its
  own parent, and there are no module-editing endpoints. When module editing is built, its service must reject
  a parent that is the module itself or one of its descendants.

### `role`
- Constraints: `fk_role_organization_id`, `ck_role_code_format`, partial uniques
  `uq_role_organization_code` (tenant roles) and `uq_role_platform_code` (platform roles)
- Indexes: `idx_role_organization_active`
- Triggers: none

### `role_module_access`
- Constraints: FKs to role and module (CASCADE), `uq_role_module_access_role_id_module_id`
- Triggers: none

### `user_role`
- Constraints: FKs to role and organization (RESTRICT), composite `fk_user_role_organization_branch_id`,
  `ck_user_role_branch_requires_organization`, partial uniques per scope (`_platform`, `_organization`, `_branch`)
- Indexes: `idx_user_role_user_active`, `idx_user_role_organization_active`
- Triggers: `trg_user_role_scope_guard` → `fn_user_role_scope_guard()` — role scope must equal assignment
  scope; one user cannot hold assignments in different scopes/organizations (SQLSTATE 23514/23503)

### `user_module_access`
- Constraints: FKs (CASCADE), `uq_user_module_access_user_role_id_module_id`,
  `ck_user_module_access_has_override` (at least one non-null flag)
- Triggers: none
