import type { RequestHandler } from "express";
import { authConfig } from "../config/auth.js";
import { RefreshOriginNotAllowedError } from "../errors/app-errors.js";

/**
 * Cookie-authenticated endpoints (refresh/logout) are the CSRF surface:
 * browsers attach the refresh cookie automatically, so the Origin must be trusted.
 */
export const requireTrustedRefreshOrigin: RequestHandler = (req, _res, next) => {
  const origin = req.get("origin")?.trim().replace(/\/$/, "");
  if (!origin) {
    next(); // non-browser client; the cookie path + SameSite still apply
    return;
  }
  const { trustedOrigins, allowUnconfiguredOrigins } = authConfig.refreshCookie;
  if (trustedOrigins.includes(origin) || (trustedOrigins.length === 0 && allowUnconfiguredOrigins)) {
    next();
    return;
  }
  throw new RefreshOriginNotAllowedError();
};

export const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
};
