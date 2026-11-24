import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEnv } from "../src/config/env.js";
import { StartupConfigError } from "../src/errors/app-errors.js";

/** The smallest valid environment. parseEnv is pure, so nothing here touches process.env or .env. */
const BASE: NodeJS.ProcessEnv = {
  POSTGRES_HOST: "127.0.0.1",
  POSTGRES_DATABASE: "events_test",
  POSTGRES_USER: "events",
  POSTGRES_PASSWORD: "events",
  CENTRAL_AUTH_API: "http://central-auth.test",
  APP_AUTH_TOKEN: "b".repeat(32),
  CENTRAL_AUTH_SERVICE_ID: "00000000-0000-4000-8000-000000000001",
};

function rejectedKeys(source: NodeJS.ProcessEnv): string[] {
  try {
    parseEnv(source);
  } catch (error) {
    assert.ok(error instanceof StartupConfigError);
    return (error.details as { keys: string[] }).keys;
  }
  return assert.fail("expected the environment to be rejected");
}

test("AUTH_REFRESH_COOKIE_PATH_PREFIX accepts /segment[/segment] and may be left unset", () => {
  assert.equal(parseEnv(BASE).AUTH_REFRESH_COOKIE_PATH_PREFIX, undefined);
  assert.equal(parseEnv({ ...BASE, AUTH_REFRESH_COOKIE_PATH_PREFIX: "/api" }).AUTH_REFRESH_COOKIE_PATH_PREFIX, "/api");
  assert.equal(parseEnv({ ...BASE, AUTH_REFRESH_COOKIE_PATH_PREFIX: "/api/v2" }).AUTH_REFRESH_COOKIE_PATH_PREFIX, "/api/v2");
});

test("a malformed AUTH_REFRESH_COOKIE_PATH_PREFIX stops startup and names only the key", () => {
  for (const value of ["api", "/api/", "//api", "/a//b", "/api prefix"]) {
    assert.deepEqual(rejectedKeys({ ...BASE, AUTH_REFRESH_COOKIE_PATH_PREFIX: value }), ["AUTH_REFRESH_COOKIE_PATH_PREFIX"], value);
  }
});

test("AUTH_CENTRAL_SESSION_TTL_SECONDS defaults to 6 hours, accepts 0 (off), rejects negatives", () => {
  assert.equal(parseEnv(BASE).AUTH_CENTRAL_SESSION_TTL_SECONDS, 21_600);
  assert.equal(parseEnv({ ...BASE, AUTH_CENTRAL_SESSION_TTL_SECONDS: "0" }).AUTH_CENTRAL_SESSION_TTL_SECONDS, 0);
  assert.deepEqual(rejectedKeys({ ...BASE, AUTH_CENTRAL_SESSION_TTL_SECONDS: "-1" }), ["AUTH_CENTRAL_SESSION_TTL_SECONDS"]);
});
