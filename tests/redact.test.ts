import assert from "node:assert/strict";
import { test } from "node:test";
import { LOG_REDACT_PATHS, redactSensitiveData } from "../src/utils/redact.js";

test("PINs and passwords are hidden from error details and logs; the mobile number is kept", () => {
  assert.deepEqual(redactSensitiveData({ mobile: "+251911000000", pin: "1234", password: "secret" }), {
    mobile: "+251911000000",
    pin: "[REDACTED]",
    password: "[REDACTED]",
  });
  assert.ok(LOG_REDACT_PATHS.includes("*.pin"), "request logs hide pin too");
  assert.ok(LOG_REDACT_PATHS.includes("*.password"));
});
