import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, mock, test } from "node:test";
import { chechePayClient } from "../src/clients/cheche-pay.client.js";
import { PaymentProviderUnavailableError } from "../src/errors/app-errors.js";

/** The Cheche Pay v2 client against a fake fetch: request shapes, answers, signatures, and the key staying secret. */
const KEY = "sk_test_supersecretkey9876";
const TX_REF = "c0000000-0000-4000-8000-000000000001-mabc123def";

function reply(status: number, body: unknown) {
  return mock.method(globalThis, "fetch", async (_url: URL | string, _init?: RequestInit) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
}

/** The URL (always a string here) and options of the first request. */
function sent(fetched: ReturnType<typeof reply>): [string, RequestInit] {
  const [url, init] = fetched.mock.calls[0]?.arguments ?? [];
  return [url as string, init ?? {}];
}

afterEach(() => mock.restoreAll());

test("initialize posts the amount, tx_ref, ETB and phone with the key in X-API-Key, and returns the checkout URL", async () => {
  const fetched = reply(200, { data: { checkout_url: "https://checkout.cheche.example/c/1", tx_ref: TX_REF, transaction_id: "cp-1", expires_at: "2026-11-26T10:30:00Z" } });
  const result = await chechePayClient.initialize({
    secretKey: KEY,
    amount: "2000.00",
    txRef: TX_REF,
    phoneNumber: "+251911234567",
    returnUrl: "https://events.example.test/orders/ABCDE23456",
    callbackUrl: "https://api.events.example.test/v1/payments/cheche/webhook/org",
  });
  const [url, init] = sent(fetched);
  assert.equal(url, "http://cheche-pay.test/api/v1/transactions/initialize");
  assert.equal(init.method, "POST");
  assert.equal((init.headers as Record<string, string>)["X-API-Key"], KEY);
  assert.deepEqual(JSON.parse(init.body as string), {
    amount: "2000.00",
    tx_ref: TX_REF,
    currency: "ETB",
    phone_number: "+251911234567",
    return_url: "https://events.example.test/orders/ABCDE23456",
    callback_url: "https://api.events.example.test/v1/payments/cheche/webhook/org",
  });
  assert.deepEqual([result.checkoutUrl, result.txRef, result.transactionId, result.expiresAt?.toISOString()], ["https://checkout.cheche.example/c/1", TX_REF, "cp-1", "2026-11-26T10:30:00.000Z"]);
});

test("localhost and private return or callback URLs are left out, because Cheche Pay refuses the whole call", async () => {
  const fetched = reply(200, { checkout_url: "https://checkout.cheche.example/c/2" });
  await chechePayClient.initialize({ secretKey: KEY, amount: "500.00", txRef: TX_REF, phoneNumber: "+251911234567", returnUrl: "http://localhost:3000/orders/X", callbackUrl: "http://192.168.1.5:4000/hook" });
  const body = JSON.parse(sent(fetched)[1].body as string) as Record<string, unknown>;
  assert.equal(body.return_url, undefined);
  assert.equal(body.callback_url, undefined);
  for (const url of ["http://127.0.0.1/x", "http://10.0.0.2/x", "http://172.20.0.1/x", "http://app.local/x", "ftp://example.com/x", "not a url"]) {
    assert.equal(chechePayClient.isPublicUrl(url), false, url);
  }
  assert.equal(chechePayClient.isPublicUrl("https://api.example.com/x"), true);
});

test("a refused or broken initialize is a 502 that never contains the key; no checkout_url is a 502 too", async () => {
  reply(401, { error: "invalid or inactive API key" });
  await assert.rejects(
    chechePayClient.initialize({ secretKey: KEY, amount: "1.00", txRef: TX_REF, phoneNumber: "+251911234567", returnUrl: null, callbackUrl: null }),
    (error: unknown) => error instanceof PaymentProviderUnavailableError && error.message === "invalid or inactive API key" && !JSON.stringify(error.details).includes(KEY),
  );
  mock.restoreAll();
  reply(200, { data: {} });
  await assert.rejects(chechePayClient.initialize({ secretKey: KEY, amount: "1.00", txRef: TX_REF, phoneNumber: "+251911234567", returnUrl: null, callbackUrl: null }), PaymentProviderUnavailableError);
  mock.restoreAll();
  reply(502, "<html>Bad gateway</html>");
  await assert.rejects(chechePayClient.initialize({ secretKey: KEY, amount: "1.00", txRef: TX_REF, phoneNumber: "+251911234567", returnUrl: null, callbackUrl: null }), PaymentProviderUnavailableError);
  mock.restoreAll();
  mock.method(globalThis, "fetch", async () => {
    throw new TypeError("fetch failed");
  });
  await assert.rejects(
    chechePayClient.initialize({ secretKey: KEY, amount: "1.00", txRef: TX_REF, phoneNumber: "+251911234567", returnUrl: null, callbackUrl: null }),
    (error: unknown) => error instanceof PaymentProviderUnavailableError && !error.message.includes(KEY),
  );
});

test("verify reads merchant-verify (status upper-cased); a tx_ref Cheche Pay doesn't know is null", async () => {
  const fetched = reply(200, { data: { status: "succeeded", amount: 2000, currency: "etb", is_final: true, transaction_id: "cp-1", tx_ref: TX_REF } });
  const verified = await chechePayClient.verify(KEY, TX_REF);
  assert.equal(sent(fetched)[0], `http://cheche-pay.test/api/v1/transactions/merchant-verify/${TX_REF}`);
  assert.equal((sent(fetched)[1].headers as Record<string, string>)["X-API-Key"], KEY);
  assert.deepEqual([verified?.status, verified?.amount, verified?.currency, verified?.isFinal, verified?.transactionId], ["SUCCEEDED", 2000, "ETB", true, "cp-1"]);
  mock.restoreAll();
  reply(404, { error: "not found" });
  assert.equal(await chechePayClient.verify(KEY, TX_REF), null);
  mock.restoreAll();
  reply(500, { error: "boom" });
  await assert.rejects(chechePayClient.verify(KEY, TX_REF), PaymentProviderUnavailableError);
});

test("checkKey: 401 or 403 is a rejected key, 404 an accepted one, anything else a provider error", async () => {
  for (const [status, reason, ok] of [
    [401, "KEY_REJECTED", false],
    [403, "KEY_REJECTED", false],
    [404, "KEY_ACCEPTED", true],
    [500, "PROVIDER_ERROR", false],
  ] as const) {
    reply(status, { error: "x" });
    const result = await chechePayClient.checkKey(KEY);
    assert.deepEqual([result.ok, result.reason, result.provider_status], [ok, reason, status]);
    mock.restoreAll();
  }
});

test("a webhook signature is the hex HMAC-SHA256 of the raw body, with or without sha256=; anything else fails", () => {
  const body = Buffer.from('{"event":"payment.succeeded"}');
  const secret = "whsec_abc12345";
  const good = createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(chechePayClient.verifySignature(body, good, secret), true);
  assert.equal(chechePayClient.verifySignature(body, `sha256=${good.toUpperCase()}`, secret), true);
  assert.equal(chechePayClient.verifySignature(body, good.slice(0, 10), secret), false, "the wrong length");
  assert.equal(chechePayClient.verifySignature(Buffer.from('{"event":"payment.failed"}'), good, secret), false, "another body");
  assert.equal(chechePayClient.verifySignature(body, undefined, secret), false);
  assert.equal(chechePayClient.verifySignature(body, " ", secret), false);
});

test("a tx_ref is the payment id plus a fresh suffix; only ours parse back", () => {
  const id = "c0000000-0000-4000-8000-000000000001";
  const first = chechePayClient.newTxRef(id);
  const second = chechePayClient.newTxRef(id);
  assert.notEqual(first, second);
  assert.equal(chechePayClient.parseTxRef(first), id);
  assert.equal(chechePayClient.parseTxRef("booking-123"), null);
  assert.equal(chechePayClient.parseTxRef(id), null, "a bare id isn't an attempt");
});
