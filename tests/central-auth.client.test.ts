import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { centralAuthClient } from "../src/clients/central-auth.client.js";
import { authConfig } from "../src/config/auth.js";
import { AppError } from "../src/errors/app-errors.js";

/** The Central Auth client against a fake fetch: no network, no Central Auth needed. */
type FetchCall = { url: string; init: RequestInit | undefined };

function fakeFetch(status: number, body: string | null): FetchCall[] {
  const calls: FetchCall[] = [];
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return new Response(body, { status, headers: { "Content-Type": "application/json" } });
  });
  return calls;
}

afterEach(() => mock.restoreAll());

test("logout posts the refresh token to /v1/auth/logout without an Authorization header", async () => {
  const calls = fakeFetch(200, JSON.stringify({ message: "Logged out" }));

  await centralAuthClient.logout("refresh-abc");

  assert.equal(calls.length, 1);
  const [{ url, init } = { url: "", init: undefined }] = calls;
  assert.equal(url, `${authConfig.centralAuthUrl}/v1/auth/logout`);
  assert.equal(init?.method, "POST");
  const body = init?.body;
  assert.ok(typeof body === "string", "the request body is a JSON string");
  assert.deepEqual(JSON.parse(body), { refresh_token: "refresh-abc" });
  const headerNames = Object.keys((init?.headers ?? {}) as Record<string, string>).map((name) => name.toLowerCase());
  assert.ok(!headerNames.includes("authorization"), "staff hold no Central access token, so none is sent");
});

test("an empty 204 reply from logout counts as success", async () => {
  fakeFetch(204, null);
  await assert.doesNotReject(centralAuthClient.logout("refresh-abc"));
});

test("a rejected logout throws, so the caller reports revoked: false", async () => {
  fakeFetch(401, JSON.stringify({ error: "Invalid refresh token" }));
  await assert.rejects(centralAuthClient.logout("refresh-abc"), AppError);
});
