# Database Foundation

Conventions: singular snake_case tables (no prefix); UUID primary keys (`gen_random_uuid()` default,
`UUIDV4` in models); audit columns `created_at`, `updated_at` (`timestamptz`, default `now()`), `created_by`,
`updated_by`; soft status `is_active`; every constraint and index named; external Central Auth ids are logical
references without FKs.

## Migration order

1. `organization` 2. `branch` 3. `module` 4. `role` 5. `role_module_access`
6. `user_role` (+ `fn_user_role_scope_guard` trigger) 7. `user_module_access`
8. seed: platform modules + `SUPER_ADMIN` role
9. `organization.has_branches` (column)
10. `customer_account` 11. `venue` 12. seed: `EVENTS` + `CUSTOMERS` modules and menu
13. grants: `EVENTS` + `CUSTOMERS` for existing `OWNER`/`VIEWER` roles
14. `organization` defaults (columns) 15. `file` 16. `event` 17. `ticket_type`
18. `event.published_at` (column, with backfill)
19. `file` entity, uploader and storage provider (columns)
20. `person` 21. `registration` 22. `message_outbox`
23. seed: `REGISTRATIONS` module and menu 24. grants: `REGISTRATIONS` for existing `OWNER`/`VIEWER` roles
25. `submission_key`

## Tables

### `organization`
- Constraints: `uq_organization_slug`, `ck_organization_slug_format`
- Indexes: `idx_organization_is_active`
- Triggers: none
- `has_branches` (boolean, default `false`, added by `20261124000000-add-organization-has-branches`): whether the
  organization's staff see branches. Every organization still has a default `MAIN` branch, created with it; when
  `has_branches` is false that branch stays hidden. Adding a branch sets it to true (`branch.service.createBranch`).

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
- Cycles (A → B → A through `parent_id`): the constraints only stop a module being its own parent. Since Phase 2e
  the module service refuses a parent that is the module itself or one of its descendants (400 `parent_cycle`),
  under the module-tree advisory lock, so two moves at once can't build one.

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

### `customer_account` (Phase 3a)
The client commissioning an event (spec §3); not an attendee.
- Columns: `name`, `kind` (`ORGANIZATION` default / `INDIVIDUAL`), `type` (sector, free text), `primary_contact_name`,
  `primary_contact_email`, `primary_contact_phone`, `is_active`
- Constraints: `fk_customer_account_organization_id` (RESTRICT), `uq_customer_account_organization_id_id`
  (tenant-safe composite key for events), `ck_customer_account_kind`, `ck_customer_account_type_organization_only`
  (an individual has no `type`)
- Indexes: `idx_customer_account_organization_active`
- Triggers: none

### `venue` (Phase 3a)
A reusable physical location (spec §4).
- Columns: `name`, `address`, `city`, `country` (ISO alpha-2), `capacity`, `is_active`
- Constraints: `fk_venue_organization_id` (RESTRICT), `uq_venue_organization_id_id` (tenant-safe composite key for
  events), `ck_venue_capacity_positive`, `ck_venue_country_format`
- Indexes: `idx_venue_organization_active`
- Triggers: none

### `organization` defaults (Phase 3b)
- Columns added by `20261125000100-add-organization-defaults`: `country` (default `ET`), `timezone` (default
  `Africa/Addis_Ababa`), `default_currency` (default `ETB`)
- Constraints: `ck_organization_country_format`, `ck_organization_default_currency_format`, `ck_organization_timezone_present`

### `file` (Phase 3b)
Tenant-scoped metadata for stored files; uploading arrives in 3d.
- Columns: `purpose` (`EVENT_COVER`), `storage_key`, `content_type`, `size_bytes`, `original_name`
- Constraints: `fk_file_organization_id` (RESTRICT), `uq_file_organization_id_id`, `uq_file_storage_key`,
  `ck_file_purpose`, `ck_file_size_positive`

### `event` (Phase 3b)
- Columns: `branch_id`, `customer_account_id`, `venue_id`, `cover_file_id` (all optional), `name`, `slug`,
  `description`, `starts_at`, `ends_at`, `timezone`, `status`, `capacity`, `registration_opens_at`,
  `registration_closes_at`, `visibility`, `category`; Phase 7: `registration_mode` (`QUICK`/`DETAILED`),
  `holder_fields` (JSONB, five keys, each `REQUIRED`/`OPTIONAL`/`HIDDEN`), `purchase_limit_per_mobile`
- Constraints: `fk_event_organization_id`, `uq_event_organization_id_id` (for ticket types and registrations),
  `uq_event_organization_id_slug`; composite FKs `fk_event_organization_branch`, `fk_event_organization_customer_account`,
  `fk_event_organization_venue`, `fk_event_organization_cover_file` (same organization; NULL links unchecked);
  `ck_event_slug_format`, `ck_event_status`, `ck_event_visibility`, `ck_event_capacity_positive`, `ck_event_dates_order`,
  `ck_event_registration_window_order`, `ck_event_published_has_dates`, `ck_event_timezone_present`
- Phase 7 constraints: `ck_event_registration_mode`, `ck_event_holder_fields`, `ck_event_purchase_limit_positive`
- Indexes: `idx_event_organization_status`, `idx_event_catalog` (`status`, `visibility`, `starts_at`)
- Triggers: none

### `ticket_type` (Phase 3b)
- Columns: `event_id`, `code`, `name`, `capacity`, `display_order`, `is_active`; Phase 7: `price` (NUMERIC(12,2),
  default 0), `currency` (the organizer's, copied), `audience` (`PUBLIC`/`STAFF_ONLY`)
- Constraints: composite `fk_ticket_type_organization_event` → `event (organization_id, id)`,
  `uq_ticket_type_organization_event_id` (for Phase 4's registration FK), `uq_ticket_type_event_code`,
  `ck_ticket_type_code_format`, `ck_ticket_type_capacity_positive`, `ck_ticket_type_display_order_non_negative`,
  Phase 7: `ck_ticket_type_price_non_negative`, `ck_ticket_type_currency_format`, `ck_ticket_type_audience`
- Indexes: `idx_ticket_type_organization_event`
- Triggers: none

### `event.published_at` (Phase 3c)
- Column added by `20261125000200-add-event-published-at`: when the event was first published; server-managed,
  set once, kept after closing or cancelling. Public direct links require it.
- Backfill: PUBLISHED/CLOSED rows got `updated_at` (fallback: no earlier record); CANCELLED and DRAFT rows stay NULL.
- Constraint: `ck_event_published_at_consistent` (DRAFT → NULL; PUBLISHED/CLOSED → NOT NULL; CANCELLED → either)

### `file` entity, uploader and storage provider (Phase 3d)
- Columns added by `20261125000300-add-file-entity-uploader-provider`:
  - `entity_type` (`EVENT`, nullable), `entity_id` (UUID, nullable): what the file belongs to;
  - `uploaded_by` (UUID, nullable): the staff member's Central Auth user id;
  - `storage_provider` (NOT NULL, default `'local'`): where the bytes live. The only NOT NULL addition, and the
    default fills any existing rows.
- Constraints: `ck_file_storage_provider` (`local` only for now), `ck_file_event_cover_entity` (an `EVENT_COVER` row
  names an `EVENT` and its id)
- Indexes: `idx_file_organization_entity` (`organization_id`, `entity_type`, `entity_id`)
- `storage_key` is the path inside `FILES_DIR` (e.g. `events/covers/<uuid>.png`). The bytes are on disk, not in the
  database. Replaced covers keep their row until a later clean-up.

### `person` (Phase 4a)
- Columns: `first_name`, `last_name`, `email`, `phone`, `affiliation_name`, `country`, `is_active`, `user_id` (Central
  Auth user, logical reference, never set by staff)
- Constraints: `fk_person_organization_id` (RESTRICT), `uq_person_organization_id_id` (for registrations),
  `uq_person_organization_user_id` (partial: non-null `user_id`), `ck_person_country_format`
- Indexes: `idx_person_organization_phone`, `idx_person_organization_email` (on `lower(email)`),
  `idx_person_organization_active`

### `registration` (Phase 4a)
- Columns: `event_id`, `person_id`, `ticket_type_id`, `status`, `source`, `registered_by`, `registered_at`,
  `cancelled_at`, `code`, `privacy_notice_version`, `privacy_notice_shown_at`, `consent_purpose`, `consent_version`,
  `consented_at`
- Constraints:
  - composite FKs `fk_registration_organization_event` → `event (organization_id, id)`,
    `fk_registration_organization_person` → `person (organization_id, id)`, and
    `fk_registration_organization_event_ticket_type` → `ticket_type (organization_id, event_id, id)`, so a ticket
    type of another event is rejected (spec rule 2);
  - `uq_registration_organization_event_person` (one row per guest per event), `uq_registration_code`,
    `uq_registration_organization_id_id`;
  - `ck_registration_status` (`CONFIRMED`, `CANCELLED`), `ck_registration_source` (`STAFF`, `PUBLIC`),
    `ck_registration_registered_by_source` (STAFF rows have `registered_by`, PUBLIC rows don't),
    `ck_registration_cancelled_at_status`, `ck_registration_privacy_notice_pair`, `ck_registration_consent_triple`,
    `ck_registration_code_format`
- Indexes: `idx_registration_event_status`, `idx_registration_ticket_type_status` (the capacity counts),
  `idx_registration_person`

### `message_outbox` (Phase 4a; sent from 4c)
- Columns: `registration_id`, `kind` (`REGISTRATION_CONFIRMATION`), `channel` (`SMS`), `recipient`, `payload` (JSONB:
  first name, organization and event names, `starts_at`, `timezone`, code), `status` (`PENDING`, `SENT`, `FAILED`,
  `SKIPPED`), `attempts`, `next_attempt_at`, `last_error`, `sent_at`, `provider_message_id`
- Constraints: composite `fk_message_outbox_organization_registration`, `ck_message_outbox_kind`,
  `ck_message_outbox_channel`, `ck_message_outbox_status`, `ck_message_outbox_attempts_non_negative`,
  `ck_message_outbox_sent_at_status`
- Indexes: `idx_message_outbox_due` (partial: `PENDING` rows by `next_attempt_at`), `idx_message_outbox_registration`
- Written in the same transaction as the registration it confirms (spec rule 5). Supporting infrastructure, not one
  of the eight business tables.

### `submission_key` (Phase 4b)
- Columns: `scope` (`PUBLIC_REGISTRATION`, `STAFF_REGISTRATION`), `key` (the `Idempotency-Key`), `request_hash`
  (sha256 of the event and the request body), `registration_id`
- Constraints: `uq_submission_key_organization_scope_key`, composite `fk_submission_key_organization_registration` →
  `registration (organization_id, id)`, `ck_submission_key_scope`, `ck_submission_key_key_format`,
  `ck_submission_key_request_hash_format`
- Indexes: `idx_submission_key_registration`
- Stored only by a successful registration, in the same transaction. Kept for now; a clean-up job comes later.
  Supporting infrastructure, not one of the eight business tables.
