import assert from "node:assert/strict";
import { test } from "node:test";
import { holderFieldIssues, DEFAULT_HOLDER_FIELDS } from "../src/utils/holder-fields.js";
import { isZeroAmount, multiplyAmount, normalizeAmount, sumAmounts } from "../src/utils/money.js";
import { moneyAmountSchema } from "../src/validators/common.js";

/** Phase 7 step 1: exact money and the holder-field rules, as pure functions. */

test("amounts are exact decimal strings with two places, added in whole cents", () => {
  assert.equal(normalizeAmount("5"), "5.00");
  assert.equal(normalizeAmount("1200.5"), "1200.50");
  assert.equal(normalizeAmount("007.25"), "7.25");
  assert.equal(multiplyAmount("500.00", 2), "1000.00");
  assert.equal(sumAmounts(["1000.00", "1000.00"]), "2000.00");
  assert.equal(sumAmounts(["0.10", "0.20"]), "0.30", "no floating-point rounding");
  assert.equal(sumAmounts([]), "0.00");
  assert.equal(isZeroAmount("0.00"), true);
  assert.equal(isZeroAmount("0.01"), false);
});

test("a price is a string such as \"500\" or \"500.50\"; numbers, negatives and three decimals are refused", () => {
  assert.equal(moneyAmountSchema.parse("500"), "500.00");
  assert.equal(moneyAmountSchema.parse(" 500.5 "), "500.50");
  for (const bad of [500, "-1", "1.234", "abc", "", "12345678901"]) {
    assert.equal(moneyAmountSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test("holder fields: required ones must be given, hidden ones must not be sent, optional ones either way", () => {
  const fields = { name: "REQUIRED", mobile: "HIDDEN", email: "REQUIRED", affiliation: "OPTIONAL", country: "HIDDEN" } as const;
  const issues = holderFieldIssues(fields, { first_name: " ", last_name: "Bekele", phone: "+251911234567", email: null, country: "ET" }, "body.items.0.holders.2");
  assert.deepEqual(issues.map((issue) => [issue.path, issue.code]), [
    ["body.items.0.holders.2.first_name", "required"],
    ["body.items.0.holders.2.phone", "not_collected"],
    ["body.items.0.holders.2.email", "required"],
    ["body.items.0.holders.2.country", "not_collected"],
  ]);

  assert.deepEqual(holderFieldIssues(fields, { first_name: "Hana", email: "hana@example.com", phone: "+251911234567" }, "body", ["mobile"]), [], "skipped fields aren't checked");
  assert.deepEqual(holderFieldIssues(DEFAULT_HOLDER_FIELDS, { first_name: "Hana", phone: "+251911234567" }, "body"), [], "today's form");
});
