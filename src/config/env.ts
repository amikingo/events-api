import { z } from "zod";
import { StartupConfigError } from "../errors/app-errors.js";

/** Comma-separated list; trims items and trailing slashes (origins). */
const csv = z
  .string()
  .transform((value) =>
    value
      .split(",")
      .map((item) => item.trim().replace(/\/$/, ""))
      .filter(Boolean),
  );

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(5000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  JSON_BODY_LIMIT: z.string().default("1mb"),
  CORS_ALLOWED_ORIGINS: csv.default([]),
  API_DOCS_ENABLED: z.stringbool().default(true),

  POSTGRES_HOST: z.string().min(1),
  POSTGRES_PORT: z.coerce.number().int().min(1).max(65_535).default(5432),
  POSTGRES_DATABASE: z.string().min(1),
  POSTGRES_USER: z.string().min(1),
  POSTGRES_PASSWORD: z.string().min(1),
  POSTGRES_SSL: z.enum(["disable", "no-verify", "verify-full"]).default("disable"),
  POSTGRES_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  APP_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),

  CENTRAL_AUTH_API: z.url(),
  // auth-cheche's shared secret (same name there). Verifies Central Auth tokens and signs this API's own
  // tokens (one secret, like bookings_api).
  APP_AUTH_TOKEN: z.string().min(32),
  CENTRAL_AUTH_SERVICE_ID: z.uuid(),
  CENTRAL_AUTH_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(10_000),

  AUTH_REFRESH_COOKIE_SECURE: z.stringbool().optional(),
  AUTH_REFRESH_COOKIE_SAME_SITE: z.enum(["strict", "lax", "none"]).default("lax"),
  AUTH_REFRESH_COOKIE_DOMAIN: z.string().min(1).optional(),
  AUTH_REFRESH_TTL_SECONDS: z.coerce.number().int().min(60).max(604_800).default(86_400),
  AUTH_REFRESH_TRUSTED_ORIGINS: csv.default([]),
  // Proxy path prefix put in front of every auth cookie path, e.g. "/api" -> "/api/v1/auth/staff".
  AUTH_REFRESH_COOKIE_PATH_PREFIX: z
    .string()
    .regex(/^(\/[A-Za-z0-9._~-]+)+$/, "must look like /segment[/segment], with no // and no trailing /")
    .optional(),
  // How long a "Central Auth confirmed this person" cookie lets staff refresh skip Central. 0 = always ask Central.
  AUTH_CENTRAL_SESSION_TTL_SECONDS: z.coerce.number().int().min(0).max(86_400).default(21_600),
});

export type Env = z.output<typeof EnvSchema>;

/**
 * The only place in the codebase that reads `process.env`.
 * Empty strings count as "unset". Errors list keys, never values.
 */
export function parseEnv(source: NodeJS.ProcessEnv): Readonly<Env> {
  const present = Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== "",
    ),
  );

  const result = EnvSchema.safeParse(present);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new StartupConfigError(`Invalid environment configuration:\n  - ${problems.join("\n  - ")}`, {
      keys: result.error.issues.map((issue) => issue.path.join(".")),
    });
  }

  return Object.freeze(result.data);
}

export const env = parseEnv(process.env);
