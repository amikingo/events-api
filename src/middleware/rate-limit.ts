import type { Request } from "express";
import { rateLimit } from "express-rate-limit";
import type { ErrorEnvelope } from "../utils/http.js";
import { normalizeEthiopianMobile } from "../utils/mobile.js";

/**
 * Per-route limiter with the standard error envelope. Keyed by client IP (relies on `trust proxy`) unless a
 * `keyGenerator` is given.
 */
export function createJsonRateLimiter(options: { windowMs: number; limit: number; message: string; keyGenerator?: (req: Request) => string }) {
  const body: ErrorEnvelope = { success: false, error: { code: "rate_limited", message: options.message } };
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: body,
    ...(options.keyGenerator ? { keyGenerator: options.keyGenerator } : {}),
  });
}

/** The mobile a request is about, normalized, so "0911…" and "+251911…" share one counter. Runs before validation. */
export function mobileRateLimitKey(req: Request): string {
  const raw: unknown = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>).mobile : undefined;
  const text = typeof raw === "string" ? raw.trim() : "";
  return `mobile:${normalizeEthiopianMobile(text) ?? (text.slice(0, 40) || "none")}`;
}

export const authLoginLimiter = createJsonRateLimiter({
  windowMs: 60_000,
  limit: 10,
  message: "Too many login attempts",
});

/** Public, no-login reads (catalog and event pages): generous, but bounded per IP. */
export const publicReadLimiter = createJsonRateLimiter({
  windowMs: 60_000,
  limit: 120,
  message: "Too many requests",
});

/** The public registration form: each submission may create a guest profile and queue an SMS, so 10 a minute per IP. */
export const publicRegistrationLimiter = createJsonRateLimiter({
  windowMs: 60_000,
  limit: 10,
  message: "Too many registration attempts",
});

export const authRefreshLimiter = createJsonRateLimiter({
  windowMs: 60_000,
  limit: 20,
  message: "Too many authentication refresh requests",
});

/** Guest sign-in, sign-up and code requests (Phase 6): 10 a minute per IP, like staff login. */
export const customerAuthLimiter = createJsonRateLimiter({
  windowMs: 60_000,
  limit: 10,
  message: "Too many attempts. Wait a minute and try again",
});

/** Sending an SMS code is also limited per mobile number: 3 every 10 minutes (decided 25 November 2026). */
export const customerCodePerMobileLimiter = createJsonRateLimiter({
  windowMs: 10 * 60_000,
  limit: 3,
  message: "Too many codes were sent to this number. Wait 10 minutes and try again",
  keyGenerator: mobileRateLimitKey,
});
