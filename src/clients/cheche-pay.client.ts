import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { paymentConfig } from "../config/payment.js";
import { PaidSalesUnavailableError, PaymentProviderUnavailableError } from "../errors/app-errors.js";
import { logger } from "../utils/logger.js";

/**
 * Cheche Pay v2, the way bookings_api uses it (Phase 7 step 3b). Every call carries the organizer's own secret key
 * (sk_test_… / sk_live_…) in X-API-Key; the key is never logged and never appears in an error.
 * - initialize: POST {finance}/transactions/initialize { amount, tx_ref, currency: "ETB", phone_number, return_url,
 *   callback_url } → the hosted checkout URL. v2 refuses a reused tx_ref (409), so each attempt has its own.
 * - verify: GET {finance}/transactions/merchant-verify/{tx_ref}: the authoritative state of one payment, scoped to the
 *   key's business. Webhooks and browser returns are only reasons to ask this.
 * - checkKey: merchant-verify for a reference that can't exist: 401/403 = key rejected, 404 = key accepted.
 * - verifySignature: X-Cheche-Signature = hex HMAC-SHA256 of the raw request body (optional "sha256=" prefix).
 * Cheche Pay refuses the whole initialize call (HTML 403) when return_url or callback_url points at localhost or a
 * private address, so such URLs are left out with a warning (the buyer then comes back by hand), as bookings does.
 * Failures throw PaymentProviderUnavailableError (502): nothing is changed and the caller may try again.
 */

export type VerifiedPayment = {
  /** Upper-cased: SUCCEEDED, PENDING, FAILED… */
  status: string | null;
  amount: string | number | null;
  currency: string | null;
  isFinal: boolean | null;
  transactionId: string | null;
  raw: unknown;
};

export type InitializeInput = {
  secretKey: string;
  amount: string;
  txRef: string;
  phoneNumber: string;
  returnUrl: string | null;
  callbackUrl: string | null;
};

export type InitializeResult = { checkoutUrl: string; txRef: string; transactionId: string | null; expiresAt: Date | null; raw: unknown };

export type KeyCheck = { ok: boolean; reason: "KEY_ACCEPTED" | "KEY_REJECTED" | "PROVIDER_ERROR"; provider_status: number; message?: string };

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : typeof value === "number" ? String(value) : null);

function financeBaseUrl(): string {
  const base = paymentConfig.chechePay.financeBaseUrl;
  if (base === null) throw new PaidSalesUnavailableError("Cheche Pay isn't configured on this server", { reason: "CHECHE_PAY_NOT_CONFIGURED" });
  return base;
}

/** v2 replies may or may not be wrapped in `data`. */
function unwrap(body: unknown): Json {
  if (isObject(body) && isObject(body.data)) return body.data;
  return isObject(body) ? body : {};
}

function providerMessage(body: unknown, fallback: string): string {
  if (!isObject(body)) return fallback;
  return text(body.message) ?? text(body.error) ?? (isObject(body.error) ? text(body.error.message) : null) ?? text(body.detail) ?? fallback;
}

async function requestJson(url: string, init: RequestInit, failureMessage: string): Promise<{ status: number; ok: boolean; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), paymentConfig.chechePay.timeoutMs);
  try {
    const response = await fetch(url, { ...init, headers: { Accept: "application/json", ...init.headers }, signal: controller.signal });
    const raw = await response.text();
    let body: unknown = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
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

/** Whether Cheche Pay will accept the URL: http(s), and not localhost or a private address. */
function isPublicUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return false;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
  }
  return true;
}

/** A fresh attempt reference: `<payment id>-<suffix>`; the payment id is read back with parseTxRef. */
function newTxRef(paymentId: string): string {
  return `${paymentId.toLowerCase()}-${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
}

const TX_REF_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([a-z0-9]{6,24})$/i;

/** The payment id inside a tx_ref we issued, or null for anyone else's. */
function parseTxRef(txRef: string): string | null {
  const match = TX_REF_PATTERN.exec(txRef.trim());
  return match?.[1] ? match[1].toLowerCase() : null;
}

async function initialize(input: InitializeInput): Promise<InitializeResult> {
  const body: Json = { amount: input.amount, tx_ref: input.txRef, currency: "ETB", phone_number: input.phoneNumber };
  for (const [field, value] of [
    ["return_url", input.returnUrl],
    ["callback_url", input.callbackUrl],
  ] as const) {
    if (value === null) continue;
    if (isPublicUrl(value)) body[field] = value;
    else logger.warn({ field, url: value }, "Not a public URL; Cheche Pay refuses it, so it was left out of initialize");
  }
  const { ok, status, body: reply } = await requestJson(
    `${financeBaseUrl()}/transactions/initialize`,
    { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": input.secretKey }, body: JSON.stringify(body) },
    "Cheche Pay checkout initialization failed",
  );
  if (!ok) throw new PaymentProviderUnavailableError(providerMessage(reply, "Cheche Pay checkout initialization failed"), { provider_status: status });
  const data = unwrap(reply);
  const checkoutUrl = text(data.checkout_url);
  if (checkoutUrl === null) throw new PaymentProviderUnavailableError("Cheche Pay initialize returned no checkout_url", { provider_status: status });
  const expires = text(data.expires_at);
  const expiresAt = expires === null ? null : new Date(expires);
  return {
    checkoutUrl,
    txRef: text(data.tx_ref) ?? input.txRef,
    transactionId: text(data.transaction_id),
    expiresAt: expiresAt !== null && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null,
    raw: reply,
  };
}

/** The payment's state at Cheche Pay; null when Cheche Pay doesn't know the tx_ref under this key (404). */
async function verify(secretKey: string, txRef: string): Promise<VerifiedPayment | null> {
  const { ok, status, body } = await requestJson(
    `${financeBaseUrl()}/transactions/merchant-verify/${encodeURIComponent(txRef)}`,
    { method: "GET", headers: { "X-API-Key": secretKey } },
    "Cheche Pay verification failed",
  );
  if (status === 404) return null;
  if (!ok) throw new PaymentProviderUnavailableError(providerMessage(body, "Cheche Pay verification failed"), { provider_status: status });
  const data = unwrap(body);
  const amount = data.amount;
  return {
    status: text(data.status)?.toUpperCase() ?? null,
    amount: typeof amount === "string" || typeof amount === "number" ? amount : null,
    currency: text(data.currency)?.toUpperCase() ?? null,
    isFinal: typeof data.is_final === "boolean" ? data.is_final : null,
    transactionId: text(data.transaction_id),
    raw: body,
  };
}

async function checkKey(secretKey: string): Promise<KeyCheck> {
  const probe = `connection-check-${randomBytes(6).toString("hex")}`;
  const { ok, status, body } = await requestJson(
    `${financeBaseUrl()}/transactions/merchant-verify/${probe}`,
    { method: "GET", headers: { "X-API-Key": secretKey } },
    "Could not reach Cheche Pay",
  );
  if (status === 401 || status === 403) return { ok: false, reason: "KEY_REJECTED", provider_status: status, message: providerMessage(body, "Cheche Pay rejected this key") };
  if (ok || status === 404) return { ok: true, reason: "KEY_ACCEPTED", provider_status: status };
  return { ok: false, reason: "PROVIDER_ERROR", provider_status: status, message: providerMessage(body, "Cheche Pay returned an error") };
}

function verifySignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (signature === undefined || signature.trim() === "") return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(rawBody).digest("hex"), "utf8");
  const provided = Buffer.from(signature.trim().toLowerCase().replace(/^sha256=/, ""), "utf8");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

export const chechePayClient = { initialize, verify, checkKey, verifySignature, newTxRef, parseTxRef, isPublicUrl };
