import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { createApp } from "../src/app.js";
import { PRIVACY_NOTICE_VERSION } from "../src/config/privacy.js";
import type { PublicRegistrationDto } from "../src/mappers/registration.mapper.js";
import { publicRegistrationLimiter } from "../src/middleware/rate-limit.js";
import { publicRegistrationService } from "../src/services/public-registration.service.js";
import type { PublicRegistrationInput } from "../src/validators/public-registration.js";
import { withServer, type TestResponse } from "./helpers/http.js";

/**
 * HTTP-level tests of the public registration route: no login, the Idempotency-Key header and the form are checked
 * by the request contract; the service is stubbed.
 */
const app = createApp();
const path = "/v1/public/organizations/selam-events/events/partner-workshop/registrations";
const KEY = "0b9c1a52-6f1e-4c35-8d2a-2a9f9d3c7e11";
const FORM = { first_name: "Liya", last_name: "Tesfaye", phone: "0912 000 001", privacy_notice_version: PRIVACY_NOTICE_VERSION };
const REPLY: PublicRegistrationDto = {
  code: "K7M2Q9XP",
  status: "CONFIRMED",
  registered_at: new Date("2026-11-26T08:00:00Z"),
  ticket_type: { code: "GA", name: "General Admission" },
  event: { name: "Partner Workshop", slug: "partner-workshop", starts_at: null, ends_at: null, timezone: "Africa/Addis_Ababa" },
  organization: { name: "Selam Events", slug: "selam-events" },
  guest: { first_name: "Liya" },
};

async function post(baseUrl: string, body: unknown, headers: Record<string, string> = { "Idempotency-Key": KEY }): Promise<TestResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}

function stubService(replayed = false) {
  return mock.method(
    publicRegistrationService,
    "registerFromPublicForm",
    async (_organizationSlug: string, _eventSlug: string, _key: string, _input: PublicRegistrationInput) => ({ registration: REPLY, replayed }),
  );
}

// These tests send more than the 10-a-minute limit from one address; the limit itself is proven in
// public-registration-rate-limit.test.ts.
beforeEach(() => publicRegistrationLimiter.resetKey("127.0.0.1"));
afterEach(() => mock.restoreAll());

test("a visitor registers without logging in: 201 with the code; the slugs, key and normalized form reach the service", async () => {
  const register = stubService();

  await withServer(app, async (baseUrl) => {
    const response = await post(baseUrl, { ...FORM, ticket_type_code: "vip", email: "liya@example.et" });
    assert.deepEqual([response.status, response.body.data.code, response.body.message], [201, "K7M2Q9XP", "Registered"]);
  });

  const [organizationSlug, eventSlug, key, input] = register.mock.calls[0]?.arguments ?? [];
  assert.deepEqual([organizationSlug, eventSlug, key], ["selam-events", "partner-workshop", KEY]);
  assert.deepEqual([input?.phone, input?.ticket_type_code, input?.email], ["+251912000001", "VIP", "liya@example.et"]);
});

test("the same request again answers 200 with the same registration", async () => {
  stubService(true);
  await withServer(app, async (baseUrl) => {
    const response = await post(baseUrl, FORM);
    assert.deepEqual([response.status, response.body.data.code, response.body.message], [200, "K7M2Q9XP", "Already registered with this request"]);
  });
});

test("Idempotency-Key is required and checked: missing or malformed is 400 at headers.idempotency-key", async () => {
  const register = stubService();
  await withServer(app, async (baseUrl) => {
    const cases: Array<Record<string, string>> = [{}, { "Idempotency-Key": "short" }, { "Idempotency-Key": "has spaces in it" }];
    for (const headers of cases) {
      const response = await post(baseUrl, FORM, headers);
      assert.equal(response.status, 400, JSON.stringify(headers));
      assert.equal(response.body.error.details.issues[0].path, "headers.idempotency-key");
    }
  });
  assert.equal(register.mock.callCount(), 0);
});

test("the form is strict: both names, an Ethiopian mobile and the notice version are required; nothing else is accepted", async () => {
  const register = stubService();
  await withServer(app, async (baseUrl) => {
    const refused = [
      { ...FORM, last_name: undefined },
      { ...FORM, phone: "+44 20 7946 0958" },
      { ...FORM, phone: undefined },
      { ...FORM, privacy_notice_version: undefined },
      { ...FORM, person_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1" },
      { ...FORM, source: "STAFF" },
      { ...FORM, ticket_type_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1" },
    ];
    for (const body of refused) {
      const response = await post(baseUrl, body);
      assert.equal(response.status, 400, JSON.stringify(body));
    }
  });
  assert.equal(register.mock.callCount(), 0);
});
