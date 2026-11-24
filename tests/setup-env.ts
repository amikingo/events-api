/**
 * Loaded with --import before any test file, so config/env.ts parses a complete environment.
 * Real values from the shell (e.g. a CI Postgres service) take precedence.
 */
const defaults: Record<string, string> = {
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  POSTGRES_HOST: "127.0.0.1",
  POSTGRES_DATABASE: "events_test",
  POSTGRES_USER: "events",
  POSTGRES_PASSWORD: "events",
  CENTRAL_AUTH_API: "http://central-auth.test",
  APP_AUTH_TOKEN: "test-central-auth-secret-at-least-32-chars",
  CENTRAL_AUTH_SERVICE_ID: "00000000-0000-4000-8000-000000000001",
  // One trusted site, so tests can prove other sites are refused (an empty list allows all outside production).
  AUTH_REFRESH_TRUSTED_ORIGINS: "http://localhost:3000",
};

for (const [key, value] of Object.entries(defaults)) {
  process.env[key] ??= value;
}
