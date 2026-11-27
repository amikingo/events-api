export type AppErrorOptions = {
  statusCode?: number;
  code?: string;
  details?: unknown;
  cause?: unknown;
};

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.statusCode = options.statusCode ?? 500;
    this.code = options.code ?? "internal_error";
    this.details = options.details;
  }
}

// ---------------------------------------------------------------------------
// Transport / generic errors
// ---------------------------------------------------------------------------

export class ValidationAppError extends AppError {
  constructor(message = "Request validation failed", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 400, code: "validation_error", details, cause: options?.cause });
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 404, code: "not_found", details, cause: options?.cause });
  }
}

/** Unmatched HTTP route. Distinct from NotFoundError so clients and tests can tell them apart. */
export class RouteNotFoundError extends AppError {
  constructor(message = "Route not found", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 404, code: "route_not_found", details, cause: options?.cause });
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "conflict", details, cause: options?.cause });
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = "Request body is too large", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 413, code: "payload_too_large", details, cause: options?.cause });
  }
}

export class StartupConfigError extends AppError {
  constructor(message = "Startup configuration is invalid", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 500, code: "startup_config_error", details, cause: options?.cause });
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = "Service unavailable", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 503, code: "service_unavailable", details, cause: options?.cause });
  }
}

// ---------------------------------------------------------------------------
// Authentication / session
// ---------------------------------------------------------------------------

export class AuthenticationRequiredError extends AppError {
  constructor(message = "Authentication required", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 401, code: "authentication_required", details, cause: options?.cause });
  }
}

export class MalformedBearerTokenError extends AppError {
  constructor(message = "Malformed bearer token", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 401, code: "malformed_bearer_token", details, cause: options?.cause });
  }
}

export class InvalidCredentialsError extends AppError {
  constructor(message = "Invalid credentials", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 401, code: "invalid_credentials", details, cause: options?.cause });
  }
}

// --- Guest accounts (Phase 6): Cheche accounts used on the public site ---------------------------

/** Sign-up for a mobile that already has a Cheche account: the site switches to sign-in. */
export class AccountExistsError extends AppError {
  constructor(message = "You already have a Cheche account. Sign in", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "account_exists", details, cause: options?.cause });
  }
}

/** No Cheche account uses this mobile: the site offers sign-up. */
export class AccountNotFoundError extends AppError {
  constructor(message = "No Cheche account uses this mobile number", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 404, code: "account_not_found", details, cause: options?.cause });
  }
}

/** The SMS code is wrong or has expired. The message is auth-cheche's when it gave one. */
export class InvalidCodeError extends AppError {
  constructor(message = "The code is wrong or has expired", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 400, code: "invalid_code", details, cause: options?.cause });
  }
}

export class InvalidTokenError extends AppError {
  constructor(message = "Invalid token", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 401, code: "invalid_token", details, cause: options?.cause });
  }
}

export class ExpiredTokenError extends AppError {
  constructor(message = "Token expired", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 401, code: "expired_token", details, cause: options?.cause });
  }
}

export class UnsupportedTokenError extends AppError {
  constructor(message = "Unsupported token", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 401, code: "unsupported_token", details, cause: options?.cause });
  }
}

export class RefreshTokenMissingError extends AppError {
  constructor(message = "Refresh token is required", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 401, code: "refresh_token_missing", details, cause: options?.cause });
  }
}

export class RefreshTokenInvalidError extends AppError {
  constructor(message = "Refresh token is invalid or expired", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 401, code: "refresh_token_invalid", details, cause: options?.cause });
  }
}

export class RefreshOriginNotAllowedError extends AppError {
  constructor(message = "Refresh origin is not allowed", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 403, code: "refresh_origin_not_allowed", details, cause: options?.cause });
  }
}

export class CentralAuthUnavailableError extends AppError {
  constructor(message = "Central Auth unavailable", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 503, code: "central_auth_unavailable", details, cause: options?.cause });
  }
}

/** auth-cheche answered 429: its per-IP rate limit, or an account locked after too many failed attempts. */
export class CentralAuthRateLimitedError extends AppError {
  constructor(message = "Too many attempts. Try again later.", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 429, code: "central_auth_rate_limited", details, cause: options?.cause });
  }
}

export class MalformedCentralAuthResponseError extends AppError {
  constructor(message = "Central Auth returned an invalid response", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 502, code: "central_auth_malformed_response", details, cause: options?.cause });
  }
}

// ---------------------------------------------------------------------------
// Authorization / tenancy
// ---------------------------------------------------------------------------

export class PermissionDeniedError extends AppError {
  constructor(message = "Permission denied", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 403, code: "permission_denied", details, cause: options?.cause });
  }
}

export class InvalidScopeError extends AppError {
  constructor(message = "Invalid tenant scope", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "invalid_tenant_scope", details, cause: options?.cause });
  }
}

export class StaffAssignmentNotFoundError extends AppError {
  constructor(message = "No active staff assignment found", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 403, code: "staff_assignment_not_found", details, cause: options?.cause });
  }
}

export class StaffContextRequiredError extends AppError {
  constructor(message = "Staff assignment context is required", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "staff_context_required", details, cause: options?.cause });
  }
}

export class RoleInactiveError extends AppError {
  constructor(message = "Role is inactive", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "role_inactive", details, cause: options?.cause });
  }
}

export class OrganizationInactiveError extends AppError {
  constructor(message = "Organization is inactive", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "organization_inactive", details, cause: options?.cause });
  }
}

export class BranchInactiveError extends AppError {
  constructor(message = "Branch is inactive", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "branch_inactive", details, cause: options?.cause });
  }
}

/** An uploaded file whose actual contents are not an accepted format (checked by magic bytes, not by name). */
export class UnsupportedFileTypeError extends AppError {
  constructor(message = "Unsupported file type", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 415, code: "unsupported_file_type", details, cause: options?.cause });
  }
}

/** The files folder is missing or not writable; nothing was recorded. */
export class FileStorageUnavailableError extends AppError {
  constructor(message = "File storage is unavailable", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 503, code: "file_storage_unavailable", details, cause: options?.cause });
  }
}

/** An event change its current status does not allow (e.g. an invalid transition, editing a CLOSED event). */
export class InvalidEventStateError extends AppError {
  constructor(message = "The event's current status does not allow this", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "invalid_event_state", details, cause: options?.cause });
  }
}

/** Publishing refused: `details.missing` lists what the event still needs. */
export class EventNotPublishableError extends AppError {
  constructor(message = "The event is not ready to publish", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "event_not_publishable", details, cause: options?.cause });
  }
}

export class InvalidBranchStateError extends AppError {
  constructor(message = "Invalid branch state", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "invalid_branch_state", details, cause: options?.cause });
  }
}

// ---------------------------------------------------------------------------
// Domain errors go below this line, grouped by feature, one class per stable
// `code`. Split into errors/<feature>-errors.ts only when this file becomes
// hard to scan (roughly 40+ classes); keep every class extending AppError.
// ---------------------------------------------------------------------------

// --- Registrations (Phase 4) ---------------------------------------------------------------

/** The event is not taking registrations: `details.reason` is NOT_PUBLISHED, NOT_OPEN_YET, CLOSED or ENDED. */
export class RegistrationClosedError extends AppError {
  constructor(message = "This event is not taking registrations", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "registration_closed", details, cause: options?.cause });
  }
}

/**
 * Phase 7: the ticket type has a price, so it can only be obtained through checkout (`details.ticket_type_code`,
 * `details.price`, `details.currency`). Paid checkout comes in Phase 7 step 3.
 */
export class PaymentRequiredError extends AppError {
  constructor(message = "This ticket type has a price: get it through checkout", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "payment_required", details, cause: options?.cause });
  }
}

/**
 * Phase 7: the buyer mobile already holds, or would hold, more tickets at this event than its purchase limit allows
 * (`details.limit`, `details.held`, `details.requested`).
 */
export class PurchaseLimitReachedError extends AppError {
  constructor(message = "This mobile number has reached the event's ticket limit", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "purchase_limit_reached", details, cause: options?.cause });
  }
}

/**
 * Phase 7 step 3b: this organizer can't sell paid tickets yet. `details.reason`: NO_CHECHE_PAY_KEYS (no active keys
 * saved for the organizer), CHECHE_PAY_NOT_CONFIGURED (the server has no Cheche Pay address or credentials key),
 * CHECHE_PAY_KEY_UNREADABLE (a saved key can't be decrypted: the credentials key changed) or CURRENCY (online payment
 * is in ETB only).
 */
export class PaidSalesUnavailableError extends AppError {
  constructor(message = "Paid tickets aren't available for this event yet", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "paid_sales_unavailable", details, cause: options?.cause });
  }
}

/** Phase 7 step 3: the ticket is held or released for an unpaid order, so it has no code and can't be changed. */
export class TicketNotIssuedError extends AppError {
  constructor(message = "This ticket hasn't been issued: its order isn't paid", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "ticket_not_issued", details, cause: options?.cause });
  }
}

/** Phase 7 step 3: the order is no longer waiting for payment (`details.status`). */
export class InvalidOrderStateError extends AppError {
  constructor(message = "This order isn't waiting for payment", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "invalid_order_state", details, cause: options?.cause });
  }
}

/** Phase 7 step 3: Cheche Pay couldn't be reached or refused; the order stays as it was and may be retried. */
export class PaymentProviderUnavailableError extends AppError {
  constructor(message = "The payment provider is not available right now. Try again in a moment", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 502, code: "payment_provider_unavailable", details, cause: options?.cause });
  }
}

/**
 * Phase 7 step 3b: a Cheche Pay webhook whose X-Cheche-Signature doesn't match the organizer's webhook secret (or is
 * missing while a secret is saved). Nothing was read or changed.
 */
export class InvalidSignatureError extends AppError {
  constructor(message = "Invalid Cheche Pay webhook signature", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 401, code: "invalid_signature", details, cause: options?.cause });
  }
}

/**
 * Phase 8: this ticket can't be admitted at the door: it isn't a confirmed, issued ticket (`details.status`: HELD,
 * RELEASED or CANCELLED, e.g. returned).
 */
export class TicketNotAdmissibleError extends AppError {
  constructor(message = "This ticket can't be admitted", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "ticket_not_admissible", details, cause: options?.cause });
  }
}

/** Phase 8: the payment case was already resolved with a different outcome (`details.resolution`); nothing changed. */
export class PaymentCaseAlreadyResolvedError extends AppError {
  constructor(message = "This case was already resolved with a different outcome", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "payment_case_already_resolved", details, cause: options?.cause });
  }
}

/** Phase 8: the ticket was admitted at the door (`details.checked_in_at`), so it can't be returned or cancelled. */
export class TicketAlreadyUsedError extends AppError {
  constructor(message = "This ticket was already used at the door", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "ticket_already_used", details, cause: options?.cause });
  }
}

/**
 * Phase 9: admission is only open from the event's door time (doors_open_at, or starts_at) up to, not including,
 * ends_at (`details.doors_open_at`, `details.ends_at`).
 */
export class OutsideAdmissionWindowError extends AppError {
  constructor(message = "Admission isn't open now", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "outside_admission_window", details, cause: options?.cause });
  }
}

/** Phase 9: the event has admitted guests (`details.admissions`), so its schedule can no longer move. */
export class EventHasAdmissionsError extends AppError {
  constructor(message = "Guests were already admitted, so the schedule can't change", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "event_has_admissions", details, cause: options?.cause });
  }
}

/** No place left: `details.scope` is EVENT (the event's capacity) or TICKET_TYPE (the ticket type's own limit). */
export class CapacityReachedError extends AppError {
  constructor(message = "No places are left", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "capacity_reached", details, cause: options?.cause });
  }
}

/** The person already holds a confirmed place at this event with another ticket type. */
export class AlreadyRegisteredError extends AppError {
  constructor(message = "This person is already registered for the event", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "already_registered", details, cause: options?.cause });
  }
}

/** A capacity can't drop below the places already confirmed against it. */
export class CapacityBelowRegistrationsError extends AppError {
  constructor(message = "The capacity can't be lower than the confirmed registrations", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "capacity_below_registrations", details, cause: options?.cause });
  }
}

/** The event offers several active ticket types, so the registration must name one. */
export class TicketTypeRequiredError extends AppError {
  constructor(message = "Choose a ticket type", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 400, code: "ticket_type_required", details, cause: options?.cause });
  }
}

/** The chosen ticket type is switched off. */
export class TicketTypeInactiveError extends AppError {
  constructor(message = "This ticket type is not available", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "ticket_type_inactive", details, cause: options?.cause });
  }
}

/** The registration is cancelled, so its ticket type can't be changed: bring the guest back first (Phase 4d). */
export class RegistrationCancelledError extends AppError {
  constructor(message = "This registration is cancelled: bring the guest back first", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "registration_cancelled", details, cause: options?.cause });
  }
}

/** The guest profile is deactivated, so it can't be registered. */
export class PersonInactiveError extends AppError {
  constructor(message = "This guest profile is deactivated", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "person_inactive", details, cause: options?.cause });
  }
}

/** The public form showed an older privacy notice: reload the event page (`details.current` is the current version). */
export class PrivacyNoticeOutdatedError extends AppError {
  constructor(message = "The privacy notice has changed; reload the page", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "privacy_notice_outdated", details, cause: options?.cause });
  }
}

/** The Idempotency-Key was already used for a different request. */
export class IdempotencyKeyReusedError extends AppError {
  constructor(message = "This Idempotency-Key was already used for a different request", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "idempotency_key_reused", details, cause: options?.cause });
  }
}

// --- Staff management (Phase 2b) -----------------------------------------------------------

/** No Cheche (auth-cheche) account uses this mobile number; the person must create one first. */
export class CentralAccountNotFoundError extends AppError {
  constructor(message = "No Cheche account uses this mobile number", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 404, code: "central_account_not_found", details, cause: options?.cause });
  }
}

/** Phase 2d: an Owner's assignment gets no permission overrides; Owners always have full access. */
export class OwnerNotOverridableError extends AppError {
  constructor(message = "An Owner always has full access, so their access can't be overridden", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "owner_not_overridable", details, cause: options?.cause });
  }
}

/** Phase 2d: nobody changes the permission overrides of their own assignment. */
export class OwnAssignmentError extends AppError {
  constructor(message = "You can't change your own access. Ask another Owner", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "own_assignment", details, cause: options?.cause });
  }
}

/**
 * Phase 2e: auth-cheche refused a change this API asked for with its service token (editing a staff member's name).
 * The staff member's own session is fine; auth-cheche said no to the service call.
 */
export class CentralAuthRefusedError extends AppError {
  constructor(message = "Cheche accounts refused this change", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "central_auth_refused", details, cause: options?.cause });
  }
}

/** Phase 2e: the platform must keep at least one active Super Admin. */
export class LastSuperAdminError extends AppError {
  constructor(message = "The platform must keep at least one active Super Admin", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "last_super_admin", details, cause: options?.cause });
  }
}

/** Phase 2e: a role can't be made from a switched-off template. */
export class RoleTemplateInactiveError extends AppError {
  constructor(message = "This template is switched off", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "role_template_inactive", details, cause: options?.cause });
  }
}

/** Phase 2e: the same role can't be held organization-wide and on a branch at the same time. */
export class AssignmentScopeConflictError extends AppError {
  constructor(message = "This person already has this role for the whole organization or for a branch. Use one or the other", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "assignment_scope_conflict", details, cause: options?.cause });
  }
}

/** Phase 2e: the admin screens need this module, or the code depends on this field of a core module. */
export class ModuleProtectedError extends AppError {
  constructor(message = "This module is protected: the platform needs it as it is", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "module_protected", details, cause: options?.cause });
  }
}

/** Phase 2e: roles, templates or overrides still grant this module (`details.grants`), so it must stay a permission module. */
export class ModuleInUseError extends AppError {
  constructor(message = "Roles, templates or overrides still grant this module; remove those grants first", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "module_in_use", details, cause: options?.cause });
  }
}

/** Phase 2e: the module tree doesn't allow this on/off change (active submodules, or a switched-off parent). */
export class InvalidModuleStateError extends AppError {
  constructor(message = "This module can't be switched in its current place in the tree", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "invalid_module_state", details, cause: options?.cause });
  }
}

/** The change would leave the organization without an active Owner. */
export class LastOwnerAssignmentError extends AppError {
  constructor(message = "The organization must keep at least one active Owner", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "last_owner_assignment", details, cause: options?.cause });
  }
}

// --- Custom roles (Phase 2c) ---------------------------------------------------------------

/** The built-in OWNER role can't be renamed, re-granted or switched off, so an organization can't lock itself out. */
export class RoleLockedError extends AppError {
  constructor(message = "The Owner role can't be changed", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "role_locked", details, cause: options?.cause });
  }
}

/** Staff still hold this role: move them to another role first (`details.active_assignments`). */
export class RoleInUseError extends AppError {
  constructor(message = "Staff still hold this role; move them to another role first", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 409, code: "role_in_use", details, cause: options?.cause });
  }
}

/** A role can't be given an action its editor doesn't hold (`details.module_code`, `details.action`). */
export class GrantExceedsOwnAccessError extends AppError {
  constructor(message = "You can't give a role access you don't have yourself", details?: unknown, options?: ErrorOptions) {
    super(message, { statusCode: 403, code: "grant_exceeds_own_access", details, cause: options?.cause });
  }
}
