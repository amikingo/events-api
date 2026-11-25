import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Loaded with --import before any test file, so config/env.ts parses a complete environment.
 * Real values from the shell (e.g. a CI Postgres service) take precedence.
 */

// Uploads always go to a temporary folder, never a real FILES_DIR from the shell. The runner process creates it and
// removes it on exit; the per-file child processes inherit EVENTS_TEST_FILES_DIR and reuse it (files run one at a time).
if (process.env.EVENTS_TEST_FILES_DIR === undefined) {
  const filesDir = mkdtempSync(join(tmpdir(), "events-api-files-"));
  process.env.EVENTS_TEST_FILES_DIR = filesDir;
  process.on("exit", () => rmSync(filesDir, { recursive: true, force: true }));
}
process.env.FILES_DIR = process.env.EVENTS_TEST_FILES_DIR;

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
