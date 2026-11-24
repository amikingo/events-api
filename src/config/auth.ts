import { APP_SLUG, CUSTOMER_REFRESH_COOKIE, STAFF_CENTRAL_SESSION_COOKIE, STAFF_REFRESH_COOKIE } from "./app.js";
import { env } from "./env.js";

const isProduction = env.NODE_ENV === "production";
const secure = env.AUTH_REFRESH_COOKIE_SECURE ?? isProduction;
// Browsers reject SameSite=None without Secure; fall back to Lax instead of emitting a dead cookie.
const sameSite = env.AUTH_REFRESH_COOKIE_SAME_SITE === "none" && !secure ? "lax" : env.AUTH_REFRESH_COOKIE_SAME_SITE;
// Behind a proxy prefix (e.g. "/api") the browser only returns cookies whose path includes it.
const cookiePathPrefix = env.AUTH_REFRESH_COOKIE_PATH_PREFIX ?? "";

export const authConfig = Object.freeze({
  appSlug: APP_SLUG,
  appTokenSecret: env.APP_AUTH_TOKEN, // Shared Central Auth secret on purpose, same as bookings_api (docs/authentication.md "Known risk").
  appTokenTtlSeconds: env.APP_TOKEN_TTL_SECONDS,
  appIssuer: `${APP_SLUG}_api`,
  appAudience: `${APP_SLUG}_api`,

  centralAuthUrl: env.CENTRAL_AUTH_API.replace(/\/$/, ""),
  centralAuthJwtSecret: env.APP_AUTH_TOKEN,
  centralIssuer: "auth_api",
  centralAuthServiceId: env.CENTRAL_AUTH_SERVICE_ID,
  centralAuthTimeoutMs: env.CENTRAL_AUTH_TIMEOUT_MS,
  /** Upper bound for the staff "Central confirmed" session; 0 disables it (every refresh asks Central). */
  centralSessionTtlSeconds: env.AUTH_CENTRAL_SESSION_TTL_SECONDS,

  refreshCookie: Object.freeze({
    staffName: STAFF_REFRESH_COOKIE,
    staffPath: `${cookiePathPrefix}/v1/auth/staff`,
    staffCentralSessionName: STAFF_CENTRAL_SESSION_COOKIE,
    customerName: CUSTOMER_REFRESH_COOKIE,
    customerPath: `${cookiePathPrefix}/v1/auth/customer`,
    secure,
    sameSite,
    domain: env.AUTH_REFRESH_COOKIE_DOMAIN ?? null,
    maxAgeSeconds: env.AUTH_REFRESH_TTL_SECONDS,
    trustedOrigins: env.AUTH_REFRESH_TRUSTED_ORIGINS,
    allowUnconfiguredOrigins: !isProduction,
  }),
});
