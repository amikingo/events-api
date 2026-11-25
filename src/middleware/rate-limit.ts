import { rateLimit } from "express-rate-limit";
import type { ErrorEnvelope } from "../utils/http.js";

/** Per-route limiter with the standard error envelope. Relies on `trust proxy` for client IPs. */
export function createJsonRateLimiter(options: { windowMs: number; limit: number; message: string }) {
  const body: ErrorEnvelope = { success: false, error: { code: "rate_limited", message: options.message } };
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: body,
  });
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

export const authRefreshLimiter = createJsonRateLimiter({
  windowMs: 60_000,
  limit: 20,
  message: "Too many authentication refresh requests",
});
