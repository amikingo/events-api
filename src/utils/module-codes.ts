/**
 * Permission-bearing module codes. Must match `module.code` rows (UPPER_SNAKE_CASE,
 * enforced by a CHECK constraint) and the keys of the `/v1/auth/staff/me` permission map.
 * Add business modules below the platform block.
 */
export const MODULE_CODES = {
  // Platform foundation
  ORGANIZATIONS: "ORGANIZATIONS",
  BRANCHES: "BRANCHES",
  MODULES: "MODULES",
  ROLE_TEMPLATES: "ROLE_TEMPLATES",
  ROLES: "ROLES",
  USER_ROLES: "USER_ROLES",
  USER_MODULE_ACCESSES: "USER_MODULE_ACCESSES",
  // Business modules
  /** Events, their ticket types, and venues. */
  EVENTS: "EVENTS",
  /** customer_account: the clients commissioning events (menu label "Clients"); not attendees. */
  CUSTOMERS: "CUSTOMERS",
  /** Guest profiles (`person`) and registrations (menu label "Guests"). */
  REGISTRATIONS: "REGISTRATIONS",
} as const;

export type ModuleCode = (typeof MODULE_CODES)[keyof typeof MODULE_CODES];
