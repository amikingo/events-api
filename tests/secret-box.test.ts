import assert from "node:assert/strict";
import { test } from "node:test";
import { PaidSalesUnavailableError } from "../src/errors/app-errors.js";
import { secretBox } from "../src/utils/secret-box.js";

/** Stored Cheche Pay keys (Phase 7 step 3b): AES-256-GCM, as bookings; the test key comes from tests/setup-env.ts. */
const OTHER_KEY = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";

test("a secret round-trips, is never stored in plain text, and is different every time", () => {
  const first = secretBox.encrypt("sk_test_abcd1234");
  const second = secretBox.encrypt("sk_test_abcd1234");
  assert.match(first, /^v1:[^:]+:[^:]+:[^:]+$/);
  assert.ok(!first.includes("sk_test"));
  assert.notEqual(first, second, "a fresh IV each time");
  assert.equal(secretBox.decrypt(first), "sk_test_abcd1234");
  assert.equal(secretBox.isConfigured(), true);
});

test("another key, altered data or an unknown format is refused, and the message names neither the secret nor the key", () => {
  const stored = secretBox.encrypt("sk_live_topsecret99");
  const refused = (error: unknown) => error instanceof PaidSalesUnavailableError && !error.message.includes("topsecret") && !error.message.includes(OTHER_KEY);
  assert.throws(() => secretBox.decrypt(stored, OTHER_KEY), refused);
  const [version, iv, tag, data] = stored.split(":") as [string, string, string, string];
  const flipped = Buffer.from(data, "base64");
  flipped[0] = (flipped[0] ?? 0) ^ 0xff;
  assert.throws(() => secretBox.decrypt([version, iv, tag, flipped.toString("base64")].join(":")), refused);
  assert.throws(() => secretBox.decrypt("plain-text"), refused);
  assert.throws(() => secretBox.encrypt("x", null), (error: unknown) => error instanceof PaidSalesUnavailableError && (error.details as { reason: string }).reason === "CHECHE_PAY_NOT_CONFIGURED");
});
