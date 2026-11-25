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
