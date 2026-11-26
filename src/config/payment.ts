import { env } from "./env.js";

/**
 * Paid checkout settings (Phase 7 step 3).
 * - chechePay: the Cheche Pay legacy payments API (as bookings_api): base URL and timeout (pay.cheche.et often takes
 *   15–25 s under load).
 * - holdMinutes: how long a paid order's places stay held while the buyer pays.
 * - worker: the payment worker releases holds past their time.
 */
export const paymentConfig = Object.freeze({
  chechePay: Object.freeze({
    baseUrl: env.CHECHE_PAY_BASE_URL.replace(/\/$/, ""),
    timeoutMs: env.CHECHE_PAY_TIMEOUT_MS,
  }),
  holdMinutes: env.PAYMENT_HOLD_MINUTES,
  worker: Object.freeze({
    enabled: env.PAYMENT_WORKER_ENABLED,
    pollIntervalMs: env.PAYMENT_POLL_INTERVAL_MS,
    batchSize: 20,
  }),
});
