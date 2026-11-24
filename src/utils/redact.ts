const SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "old_password",
  "new_password",
  "otp",
  "pin",
  "token",
  "access_token",
  "refresh_token",
  "refreshtoken",
  "secret",
  "key",
  "credential",
]);

/** Deep-copies `value`, replacing sensitive keys with "[REDACTED]". Used for error details and logs. */
export function redactSensitiveData(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveData(item, depth + 1));
  }
  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    redacted[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? "[REDACTED]" : redactSensitiveData(item, depth + 1);
  }
  return redacted;
}

/** pino `redact.paths` mirroring SENSITIVE_KEYS for request logging. */
export const LOG_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "*.password",
  "*.token",
  "*.access_token",
  "*.refresh_token",
  "*.otp",
  "*.pin",
  "*.secret",
];
