import { paymentConfig } from "../config/payment.js";
import { PaymentProviderUnavailableError } from "../errors/app-errors.js";
import { logger } from "../utils/logger.js";

/**
 * Cheche Pay, the way bookings_api uses it (Phase 7 step 3): the legacy payments API, no API key.
 * - listPaymentOptions(code): the payment options (Telebirr and others) registered for an organizer's service code,
 *   GET {base}/payment-services/{code}. Cheche Pay answers an unknown code with success and an empty list, so []
 *   means "not registered".
 * - createOrder: POST {base}/createOrder/{paymentOption_id} with { title, paymentType, transaction_id, user_id,
 *   amount, phone_number }. `transaction_id` is our payment row id; Cheche Pay echoes it in its callback. Returns the
 *   checkout `url` to send the buyer to, Cheche Pay's own order id when it gives one, and the raw reply (kept for
 *   review). pay.cheche.et often takes 15–25 s under load, hence the 45 s default timeout (as bookings).
 * Failures throw PaymentProviderUnavailableError (502): nothing is changed and the caller may try again.
 */
export type PaymentOption = { id: string; name: string | null; raw: unknown };

export type CreateOrderInput = {
  paymentOptionId: string;
  title: string;
  paymentType: "C2B";
  transactionId: string;
  userId: string | null;
  amount: string;
  phoneNumber: string;
};

export type CreateOrderResult = { url: string | null; providerOrderId: string | null; raw: unknown };

async function requestJson(url: string, init: RequestInit, failureMessage: string): Promise<{ status: number; ok: boolean; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), paymentConfig.chechePay.timeoutMs);
  try {
    const response = await fetch(url, { ...init, headers: { Accept: "application/json", ...init.headers }, signal: controller.signal });
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new PaymentProviderUnavailableError(`${failureMessage}: Cheche Pay returned a non-JSON response (HTTP ${response.status})`, { provider_status: response.status });
      }
    }
    return { status: response.status, ok: response.ok, body };
  } catch (error) {
    if (error instanceof PaymentProviderUnavailableError) throw error;
    const timedOut = error instanceof Error && error.name === "AbortError";
    throw new PaymentProviderUnavailableError(timedOut ? `${failureMessage} (timed out)` : failureMessage, { reason: error instanceof Error ? error.message : "unknown" });
  } finally {
    clearTimeout(timer);
  }
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : typeof value === "number" ? String(value) : null);

function providerMessage(body: unknown, fallback: string): string {
  if (!isObject(body)) return fallback;
  return text(body.message) ?? text(body.error) ?? (isObject(body.error) ? text(body.error.message) : null) ?? text(body.detail) ?? fallback;
}

async function listPaymentOptions(serviceCode: string): Promise<PaymentOption[]> {
  const { ok, status, body } = await requestJson(
    `${paymentConfig.chechePay.baseUrl}/payment-services/${encodeURIComponent(serviceCode)}`,
    { method: "GET" },
    "Could not load the Cheche Pay payment options",
  );
  if (!ok) throw new PaymentProviderUnavailableError("Cheche Pay could not list the payment options", { provider_status: status });
  const list = isObject(body) && Array.isArray(body.data) ? body.data : [];
  return list
    .filter(isObject)
    .map((option) => ({ id: text(option.id) ?? text(option._id) ?? text(option.paymentOption_id) ?? "", name: text(option.name) ?? text(option.title) ?? text(option.label), raw: option }))
    .filter((option) => option.id !== "");
}

/** The reply may nest the result (bookings reads data.chechePayresult first); this reads the same places. */
function pickResult(body: unknown): Json | null {
  if (!isObject(body)) return null;
  const data = isObject(body.data) ? body.data : null;
  const candidates = [data?.chechePayresult, isObject(data?.data) ? data.data.chechePayresult : undefined, body.chechePayresult, data, body];
  return candidates.find(isObject) ?? null;
}

async function createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
  const { ok, status, body } = await requestJson(
    `${paymentConfig.chechePay.baseUrl}/createOrder/${encodeURIComponent(input.paymentOptionId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: input.title,
        paymentType: input.paymentType,
        transaction_id: input.transactionId,
        user_id: input.userId,
        amount: input.amount,
        phone_number: input.phoneNumber,
      }),
    },
    "Cheche Pay order creation failed",
  );
  if (!ok) throw new PaymentProviderUnavailableError(providerMessage(body, "Cheche Pay order creation failed"), { provider_status: status });
  const result = pickResult(body);
  if (!result) throw new PaymentProviderUnavailableError("Cheche Pay order creation returned an invalid response", { provider_status: status });
  const url = text(result.url) ?? text(result.redirect_url) ?? text(result.redirectUrl) ?? text(result.payment_url);
  const raw = isObject(result.raw) ? result.raw : result;
  const providerOrderId = text(raw.merch_order_id) ?? text(raw.order_id) ?? text(result.merch_order_id) ?? null;
  if (!url) logger.warn({ transactionId: input.transactionId }, "Cheche Pay created the order without a checkout url");
  return { url, providerOrderId, raw: body };
}

export const chechePayClient = { listPaymentOptions, createOrder };
