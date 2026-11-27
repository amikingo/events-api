import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEnv } from "../src/config/env.js";
import { chechePayCallbackUrl, chechePayReturnUrl, paymentUrlTemplates } from "../src/config/payment.js";
import { StartupConfigError } from "../src/errors/app-errors.js";

/** Cheche Pay's callback and return addresses (Phase 10), as bookings. Pure: no process.env, no .env. */
const ORG = "11111111-1111-4111-8111-111111111111";
const NONE = { CHECHE_PAY_CALLBACK_URL: undefined, CHECHE_PAY_RETURN_URL: undefined, PUBLIC_API_BASE_URL: undefined, PAYMENT_RETURN_URL: undefined, CHECHE_PAY_FINANCE_BASE_URL: undefined };
const BASE: NodeJS.ProcessEnv = {
  POSTGRES_HOST: "127.0.0.1",
  POSTGRES_DATABASE: "events_test",
  POSTGRES_USER: "events",
  POSTGRES_PASSWORD: "events",
  CENTRAL_AUTH_API: "http://central-auth.test",
  APP_AUTH_TOKEN: "b".repeat(32),
  CENTRAL_AUTH_SERVICE_ID: "00000000-0000-4000-8000-000000000001",
};

test("CHECHE_PAY_CALLBACK_URL with {organization_id} is filled per organizer; one ending in /webhook gets the id added", () => {
  const withPlaceholder = paymentUrlTemplates({ ...NONE, CHECHE_PAY_CALLBACK_URL: "https://api.example/v1/payments/cheche/webhook/{organization_id}" });
  assert.equal(chechePayCallbackUrl(ORG, withPlaceholder.callback), `https://api.example/v1/payments/cheche/webhook/${ORG}`);

  const endsInWebhook = paymentUrlTemplates({ ...NONE, CHECHE_PAY_CALLBACK_URL: "https://api.example/v1/payments/cheche/webhook/" });
  assert.equal(chechePayCallbackUrl(ORG, endsInWebhook.callback), `https://api.example/v1/payments/cheche/webhook/${ORG}`);
  assert.deepEqual(endsInWebhook.warnings, []);
});

test("CHECHE_PAY_RETURN_URL fills {reference} and {tx_ref}; without placeholders both are added as query values", () => {
  const both = paymentUrlTemplates({ ...NONE, CHECHE_PAY_RETURN_URL: "https://events.example/orders/{reference}?tx_ref={tx_ref}" });
  assert.equal(chechePayReturnUrl("EVT-AB12", "pay-1-x9", both.return), "https://events.example/orders/EVT-AB12?tx_ref=pay-1-x9");

  const txOnly = paymentUrlTemplates({ ...NONE, CHECHE_PAY_RETURN_URL: "https://events.example/payment/{tx_ref}" });
  assert.equal(chechePayReturnUrl("EVT-AB12", "pay-1-x9", txOnly.return), "https://events.example/payment/pay-1-x9");

  const plain = paymentUrlTemplates({ ...NONE, CHECHE_PAY_RETURN_URL: "https://events.example/payment-return" });
  assert.equal(chechePayReturnUrl("EVT-AB12", "pay-1-x9", plain.return), "https://events.example/payment-return?reference=EVT-AB12&tx_ref=pay-1-x9");
});

test("the older PUBLIC_API_BASE_URL and PAYMENT_RETURN_URL still work, with a deprecation warning each", () => {
  const legacy = paymentUrlTemplates({ ...NONE, PUBLIC_API_BASE_URL: "https://api.example/", PAYMENT_RETURN_URL: "https://events.example/" });
  assert.equal(chechePayCallbackUrl(ORG, legacy.callback), `https://api.example/v1/payments/cheche/webhook/${ORG}`);
  assert.equal(chechePayReturnUrl("EVT-AB12", "pay-1-x9", legacy.return), "https://events.example/orders/EVT-AB12");
  assert.equal(legacy.warnings.length, 2);
});

test("with Cheche Pay on but no callback address, startup warns; nothing configured gives no addresses", () => {
  const noCallback = paymentUrlTemplates({ ...NONE, CHECHE_PAY_FINANCE_BASE_URL: "https://pay.example/api/v1" });
  assert.equal(noCallback.callback, null);
  assert.match(noCallback.warnings.join("\n"), /CHECHE_PAY_CALLBACK_URL is not set/);
  assert.equal(chechePayCallbackUrl(ORG, null), null);
  assert.equal(chechePayReturnUrl("EVT-AB12", "pay-1-x9", null), null);
});

test("a callback URL without {organization_id} or /webhook, or a non-http address, stops startup", () => {
  for (const value of ["https://api.example/payments/notify", "ftp://api.example/webhook"]) {
    assert.throws(() => parseEnv({ ...BASE, CHECHE_PAY_CALLBACK_URL: value }), (error: unknown) => {
      assert.ok(error instanceof StartupConfigError);
      assert.deepEqual((error.details as { keys: string[] }).keys, ["CHECHE_PAY_CALLBACK_URL"]);
      return true;
    });
  }
  assert.equal(parseEnv({ ...BASE, CHECHE_PAY_CALLBACK_URL: "https://api.example/webhook/{organization_id}" }).CHECHE_PAY_CALLBACK_URL, "https://api.example/webhook/{organization_id}");
});
