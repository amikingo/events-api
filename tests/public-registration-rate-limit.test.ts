import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { withServer } from "./helpers/http.js";

/** Its own file: the limiter's count lives in this test process, so no other test shares it. */
const app = createApp();
const path = "/v1/public/organizations/selam-events/events/partner-workshop/registrations";

test("the public registration form allows 10 submissions a minute per IP, then 429 rate_limited", async () => {
  await withServer(app, async (baseUrl) => {
    const statuses: number[] = [];
    let last: { error?: { code?: string } } | null = null;
    for (let attempt = 0; attempt < 11; attempt += 1) {
      // An invalid form: the limiter counts it before validation, and nothing reaches the service.
      const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      statuses.push(response.status);
      last = (await response.json()) as { error?: { code?: string } };
    }
    assert.deepEqual(statuses, [...Array<number>(10).fill(400), 429]);
    assert.equal(last?.error?.code, "rate_limited");
  });
});
