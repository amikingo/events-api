import type { ErrorRequestHandler, RequestHandler } from "express";
import jwt from "jsonwebtoken";
import {
  DatabaseError,
  ForeignKeyConstraintError,
  UniqueConstraintError,
  ValidationError as SequelizeValidationError,
} from "sequelize";
import { ZodError } from "zod";
import {
  AppError,
  ConflictError,
  ExpiredTokenError,
  InvalidTokenError,
  PayloadTooLargeError,
  RouteNotFoundError,
  UnsupportedTokenError,
  ValidationAppError,
} from "../errors/app-errors.js";
import type { ErrorEnvelope } from "../utils/http.js";
import { logger } from "../utils/logger.js";
import { redactSensitiveData } from "../utils/redact.js";

export const notFound: RequestHandler = (req) => {
  // req.path, not originalUrl: never echo query strings (they can carry tokens).
  throw new RouteNotFoundError(`Route not found: ${req.method} ${req.path}`);
};

function isBodyParserError(error: unknown): error is { type: string } {
  return typeof error === "object" && error !== null && "type" in error && typeof error.type === "string" && "status" in error;
}

function postgresCode(error: DatabaseError): string | undefined {
  const parent = error.parent as { code?: unknown } | undefined;
  return typeof parent?.code === "string" ? parent.code : undefined;
}

/** Converts anything thrown into an AppError. Unknown errors become a generic 500. */
export function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  if (error instanceof ZodError) {
    return new ValidationAppError("Request validation failed", {
      issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message, code: issue.code })),
    });
  }

  if (isBodyParserError(error)) {
    if (error.type === "entity.too.large") return new PayloadTooLargeError();
    if (error.type === "entity.parse.failed") return new ValidationAppError("Malformed JSON body");
    return new ValidationAppError("Invalid request body");
  }

  // Order matters: UniqueConstraintError extends Sequelize's ValidationError.
  if (error instanceof UniqueConstraintError) {
    // Field names only: values could disclose another tenant's data.
    return new ConflictError("A unique constraint was violated", { fields: Object.keys(error.fields ?? {}) });
  }
  if (error instanceof ForeignKeyConstraintError) {
    return new ConflictError("A referenced record does not exist");
  }
  if (error instanceof SequelizeValidationError) {
    return new ValidationAppError("Request validation failed", {
      issues: error.errors.map((item) => ({ path: item.path, message: item.message })),
    });
  }
  if (error instanceof DatabaseError) {
    switch (postgresCode(error)) {
      case "23505":
        return new ConflictError("A unique constraint was violated");
      case "23503":
        return new ConflictError("A referenced record does not exist");
      case "23514":
        return new ValidationAppError("A database check constraint was violated");
      case "23502":
        return new ValidationAppError("A required value is missing");
      case "22P02":
        return new ValidationAppError("A value has an invalid format");
      default:
        break;
    }
  }

  if (error instanceof jwt.TokenExpiredError) return new ExpiredTokenError();
  if (error instanceof jwt.JsonWebTokenError) {
    return /audience|issuer/i.test(error.message) ? new UnsupportedTokenError() : new InvalidTokenError();
  }

  return new AppError("Internal server error");
}

function safeErrorLog(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { value: redactSensitiveData(error) };
  return {
    type: error.name,
    message: error.message,
    stack: error.stack,
    ...(error instanceof AppError ? { code: error.code, details: redactSensitiveData(error.details) } : {}),
    ...(error.cause instanceof Error ? { cause: { type: error.cause.name, message: error.cause.message } } : {}),
  };
}

export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  const normalized = normalizeError(error);
  const log = req.log ?? logger;
  if (normalized.statusCode >= 500) {
    log.error({ err: safeErrorLog(error), code: normalized.code }, "Request failed");
  } else {
    // The cause (e.g. "Central Auth 403: ...") explains a refusal whose client message is deliberately generic.
    const cause = error instanceof Error && error.cause instanceof Error ? { cause: error.cause.message } : {};
    log.info({ code: normalized.code, statusCode: normalized.statusCode, ...cause }, "Request rejected");
  }

  const body: ErrorEnvelope = { success: false, error: { code: normalized.code, message: normalized.message } };
  if (normalized.details !== undefined) body.error.details = redactSensitiveData(normalized.details);
  res.status(normalized.statusCode).json(body);
};
