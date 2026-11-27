import { env, type Env } from "./env.js";

/**
 * Paid checkout settings (Phase 7 step 3b, Cheche Pay v2).
 * - chechePay: the v2 API base (null = paid sales unavailable) and the timeout (Cheche Pay often takes 15–25 s under
 *   load, as bookings found).
 * - credentialsKey: decrypts the organizers' stored keys (null = paid sales unavailable). Read only by utils/secret-box.
 * - callbackUrlTemplate / returnUrlTemplate: where Cheche Pay calls us and where it sends the buyer back, as bookings
 *   (CHECHE_PAY_CALLBACK_URL with {organization_id}, CHECHE_PAY_RETURN_URL with {tx_ref}, plus {reference} for our order
 *   page). The older PUBLIC_API_BASE_URL and PAYMENT_RETURN_URL still work when the new ones are unset; `warnings` says
 *   so at startup.
 * - holdMinutes: how long a paid order's places stay held while the buyer pays.
 * - worker: the payment worker asks Cheche Pay about unconfirmed attempts, then releases holds past their time.
 */
const trimSlash = (value: string) => value.replace(/\/$/, "");

type UrlSettings = Pick<Env, "CHECHE_PAY_CALLBACK_URL" | "CHECHE_PAY_RETURN_URL" | "PUBLIC_API_BASE_URL" | "PAYMENT_RETURN_URL" | "CHECHE_PAY_FINANCE_BASE_URL">;

/** The callback and return templates, and the startup warnings, from the settings (pure, so tests pass their own). */
export function paymentUrlTemplates(source: UrlSettings): { callback: string | null; return: string | null; warnings: string[] } {
  let callback: string | null = null;
  if (source.CHECHE_PAY_CALLBACK_URL) {
    const value = source.CHECHE_PAY_CALLBACK_URL;
    callback = value.includes("{organization_id}") ? value : `${trimSlash(value)}/{organization_id}`;
  } else if (source.PUBLIC_API_BASE_URL) {
    callback = `${trimSlash(source.PUBLIC_API_BASE_URL)}/v1/payments/cheche/webhook/{organization_id}`;
  }
  const returnTemplate = source.CHECHE_PAY_RETURN_URL ?? (source.PAYMENT_RETURN_URL ? `${trimSlash(source.PAYMENT_RETURN_URL)}/orders/{reference}` : null);

  const warnings: string[] = [];
  if (!source.CHECHE_PAY_CALLBACK_URL && source.PUBLIC_API_BASE_URL) warnings.push("PUBLIC_API_BASE_URL is deprecated: set CHECHE_PAY_CALLBACK_URL (with {organization_id})");
  if (!source.CHECHE_PAY_RETURN_URL && source.PAYMENT_RETURN_URL) warnings.push("PAYMENT_RETURN_URL is deprecated: set CHECHE_PAY_RETURN_URL (with {reference} and/or {tx_ref})");
  if (source.CHECHE_PAY_FINANCE_BASE_URL && callback === null) {
    warnings.push("CHECHE_PAY_CALLBACK_URL is not set: Cheche Pay can't call back, so payments are confirmed only when buyers return or by the payment worker");
  }
  return { callback, return: returnTemplate, warnings };
}

const templates = paymentUrlTemplates(env);

export const paymentConfig = Object.freeze({
  chechePay: Object.freeze({
    financeBaseUrl: env.CHECHE_PAY_FINANCE_BASE_URL?.replace(/\/$/, "") ?? null,
    timeoutMs: env.CHECHE_PAY_TIMEOUT_MS,
  }),
  credentialsKey: env.CHECHE_PAY_CREDENTIALS_KEY ?? null,
  callbackUrlTemplate: templates.callback,
  returnUrlTemplate: templates.return,
  warnings: Object.freeze([...templates.warnings]),
  holdMinutes: env.PAYMENT_HOLD_MINUTES,
  worker: Object.freeze({
    enabled: env.PAYMENT_WORKER_ENABLED,
    pollIntervalMs: env.PAYMENT_POLL_INTERVAL_MS,
    batchSize: 20,
  }),
});

/** Cheche Pay's per-organizer callback (null when no callback URL is configured). */
export function chechePayCallbackUrl(organizationId: string, template: string | null = paymentConfig.callbackUrlTemplate): string | null {
  return template?.replace("{organization_id}", encodeURIComponent(organizationId)) ?? null;
}

/** Where Cheche Pay sends the buyer back for one attempt (null when no return URL is configured). */
export function chechePayReturnUrl(reference: string, txRef: string, template: string | null = paymentConfig.returnUrlTemplate): string | null {
  if (template === null) return null;
  if (template.includes("{reference}") || template.includes("{tx_ref}")) {
    return template.replace("{reference}", encodeURIComponent(reference)).replace("{tx_ref}", encodeURIComponent(txRef));
  }
  const url = new URL(template);
  url.searchParams.set("reference", reference);
  url.searchParams.set("tx_ref", txRef);
  return url.toString();
}
