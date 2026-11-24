import type { CookieOptions, Request, Response } from "express";
import { authConfig } from "../config/auth.js";

export type RefreshCookieKind = "staff" | "customer";

function cookieIdentity(kind: RefreshCookieKind): { name: string; path: string } {
  const { refreshCookie } = authConfig;
  return kind === "staff"
    ? { name: refreshCookie.staffName, path: refreshCookie.staffPath }
    : { name: refreshCookie.customerName, path: refreshCookie.customerPath };
}

function baseOptions(path: string): CookieOptions {
  const { refreshCookie } = authConfig;
  return {
    httpOnly: true,
    secure: refreshCookie.secure,
    sameSite: refreshCookie.sameSite,
    path,
    ...(refreshCookie.domain ? { domain: refreshCookie.domain } : {}),
  };
}

function parseCookieHeader(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const raw = part.slice(index + 1).trim();
    try {
      cookies[name] = decodeURIComponent(raw);
    } catch {
      cookies[name] = raw;
    }
  }
  return cookies;
}

export function getRefreshCookie(req: Request, kind: RefreshCookieKind): string | null {
  return parseCookieHeader(req.get("cookie"))[cookieIdentity(kind).name] ?? null;
}

export function setRefreshCookie(res: Response, kind: RefreshCookieKind, token: string, maxAgeSeconds?: number): void {
  const { name, path } = cookieIdentity(kind);
  const seconds = Math.min(maxAgeSeconds ?? authConfig.refreshCookie.maxAgeSeconds, authConfig.refreshCookie.maxAgeSeconds);
  res.cookie(name, token, { ...baseOptions(path), maxAge: seconds * 1000 });
}

export function clearRefreshCookie(res: Response, kind: RefreshCookieKind): void {
  const { name, path } = cookieIdentity(kind);
  res.clearCookie(name, baseOptions(path));
}

// Staff "Central confirmed" session cookie: same options and path as the staff refresh cookie.
// Its lifetime is the confirmation token's own (already capped by AUTH_CENTRAL_SESSION_TTL_SECONDS).

export function getStaffCentralSessionCookie(req: Request): string | null {
  return parseCookieHeader(req.get("cookie"))[authConfig.refreshCookie.staffCentralSessionName] ?? null;
}

export function setStaffCentralSessionCookie(res: Response, token: string, maxAgeSeconds: number): void {
  const { staffCentralSessionName, staffPath } = authConfig.refreshCookie;
  res.cookie(staffCentralSessionName, token, { ...baseOptions(staffPath), maxAge: maxAgeSeconds * 1000 });
}

export function clearStaffCentralSessionCookie(res: Response): void {
  const { staffCentralSessionName, staffPath } = authConfig.refreshCookie;
  res.clearCookie(staffCentralSessionName, baseOptions(staffPath));
}
