import { env } from "./env.js";

/**
 * Paid checkout settings (Phase 7 step 3b, Cheche Pay v2).
 * - chechePay: the v2 API base (null = paid sales unavailable) and the timeout (Cheche Pay often takes 15–25 s under
 *   load, as bookings found).
 * - credentialsKey: decrypts the organizers' stored keys (null = paid sales unavailable). Read only by utils/secret-box.
 * - returnUrl / publicApiBaseUrl: where Cheche Pay sends the buyer back, and where it calls us (both optional).
 * - holdMinutes: how long a paid order's places stay held while the buyer pays.
 * - worker: the payment worker releases holds past their time.
 */
export const paymentConfig = Object.freeze({
  chechePay: Object.freeze({
    financeBaseUrl: env.CHECHE_PAY_FINANCE_BASE_URL?.replace(/\/$/, "") ?? null,
    timeoutMs: env.CHECHE_PAY_TIMEOUT_MS,
  }),
  credentialsKey: env.CHECHE_PAY_CREDENTIALS_KEY ?? null,
  returnUrl: env.PAYMENT_RETURN_URL?.replace(/\/$/, "") ?? null,
  publicApiBaseUrl: env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") ?? null,
  holdMinutes: env.PAYMENT_HOLD_MINUTES,
  worker: Object.freeze({
    enabled: env.PAYMENT_WORKER_ENABLED,
    pollIntervalMs: env.PAYMENT_POLL_INTERVAL_MS,
    batchSize: 20,
  }),
});
