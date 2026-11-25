import { env } from "./env.js";

/**
 * Confirmation SMS settings (Phase 4c). The AfroMessage token comes only from PLATFORM_SMS_AFROMESSAGE_TOKEN and is
 * never logged or put in an error. env.ts refuses SMS_DELIVERY=afromessage without the token, from id and sender.
 */
export const smsConfig = Object.freeze({
  delivery: env.SMS_DELIVERY,
  afromessage: Object.freeze({
    baseUrl: "https://api.afromessage.com/api/send",
    token: env.PLATFORM_SMS_AFROMESSAGE_TOKEN ?? null,
    fromId: env.PLATFORM_SMS_AFROMESSAGE_FROM_ID ?? null,
    sender: env.PLATFORM_SMS_SENDER ?? null,
  }),
  timeoutMs: env.SMS_TIMEOUT_MS,
  dailyLimit: env.SMS_DAILY_LIMIT,
  /** At most this many SMS to one phone per hour; more are SKIPPED. */
  perRecipientHourlyLimit: 5,
  worker: Object.freeze({
    enabled: env.OUTBOX_WORKER_ENABLED,
    pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
    batchSize: 20,
    /** A claimed message is not claimed again for this long (a crash mid-send retries after the lease). */
    leaseMs: 5 * 60_000,
    /** Retry delays after the 1st, 2nd, 3rd and 4th failure; the 5th failure is final (FAILED). */
    retryDelaysMs: [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const,
    maxAttempts: 5,
  }),
});
