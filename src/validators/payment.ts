import { z } from "zod";
import { ValidationAppError } from "../errors/app-errors.js";
import type { RequestContract } from "../middleware/validate.js";
import { MONEY_PATTERN, normalizeAmount } from "../utils/money.js";
import { organizationIdParamsSchema } from "./common.js";
import { publicEventParamsSchema } from "./public-event.js";

/**
 * Paid checkout through Cheche Pay (Phase 7 step 3).
 * - The organizer's Cheche Pay service code, set at platform scope (upper-case; null turns paid sales off).
 * - The buyer's order page: the order reference in the path and the order token in the `X-Order-Token` header (never
 *   in the URL, so it stays out of logs and browser history).
 * - Cheche Pay's callback (notify-from-chechepay), POST body or GET query, with the same field names bookings
 *   accepts: transaction_id (our payment id) | transactionId | internal_ref, trade_status | tradeStatus,
 *   transaction_amount | transactionAmount | amount, and Cheche Pay's reference vendor_ref | vendor_reference |
 *   vendorReference | merch_order_id | payment_order_id | trans_id. Aliases must agree. Other fields are ignored.
 */
export const chechePayServiceUpdateSchema = z.strictObject({
  cheche_pay_service: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9_-]{1,80}$/, "A Cheche Pay service code: letters, digits, - and _"))
    .nullable(),
});

export const publicOrderParamsSchema = z.strictObject({ reference: z.string().trim().regex(/^[A-HJKMNP-Z2-9]{8,10}$/, "An order reference") });
export const orderTokenHeadersSchema = z.object({ "x-order-token": z.string().trim().regex(/^[A-Za-z0-9_-]{20,100}$/, "The order token from checkout") });

/** Cheche Pay may send numbers or strings; blanks count as missing. */
const looseText = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() || undefined : typeof value === "number" ? String(value) : value === null ? undefined : value),
  z.string().max(255).optional(),
);

const TRANSACTION_ALIASES = ["transaction_id", "transactionId", "internal_ref"] as const;
const STATUS_ALIASES = ["trade_status", "tradeStatus"] as const;
const AMOUNT_ALIASES = ["transaction_amount", "transactionAmount", "amount"] as const;
const VENDOR_ALIASES = ["vendor_ref", "vendor_reference", "vendorReference", "merch_order_id", "payment_order_id", "trans_id"] as const;
const ALL_ALIASES = [...TRANSACTION_ALIASES, ...STATUS_ALIASES, ...AMOUNT_ALIASES, ...VENDOR_ALIASES] as const;

export type ChechePayNotificationInput = {
  transactionId: string | null;
  tradeStatus: string;
  /** Normalized to two decimals ("500" → "500.00"). */
  amount: string;
  vendorRef: string;
  /** The recognised fields as received, kept on the payment for review. */
  raw: Record<string, string>;
};

/** The callback's recognised fields (other fields are dropped); read by readChechePayNotification. */
export const chechePayNotificationSchema = z.object(
  Object.fromEntries(ALL_ALIASES.map((key) => [key, looseText])) as Record<(typeof ALL_ALIASES)[number], typeof looseText>,
);

export type ChechePayNotificationFields = z.output<typeof chechePayNotificationSchema>;

/**
 * The callback's meaning from its aliases (bookings' rules): vendor_ref, trade_status and the amount are required;
 * transaction_id may be missing when vendor_ref names Cheche Pay's own order id. Aliases that disagree are refused.
 * A 400 names the field.
 */
export function readChechePayNotification(fields: ChechePayNotificationFields): ChechePayNotificationInput {
  const issues: Array<{ path: string; message: string; code: string }> = [];
  const values = fields as Record<string, string | undefined>;
  const pick = (aliases: readonly string[], label: string, required: boolean): string | null => {
    const found = [...new Set(aliases.map((key) => values[key]).filter((item): item is string => item !== undefined))];
    if (found.length > 1) issues.push({ path: aliases[0] as string, message: `${label} aliases must match`, code: "conflicting_aliases" });
    if (found.length === 0 && required) issues.push({ path: aliases[0] as string, message: `${label} is required`, code: "required" });
    return found[0] ?? null;
  };
  const vendorRef = pick(VENDOR_ALIASES, "vendor_ref", true);
  const transactionId = pick(TRANSACTION_ALIASES, "transaction_id", false);
  const tradeStatus = pick(STATUS_ALIASES, "trade_status", true);
  const amount = pick(AMOUNT_ALIASES, "transaction_amount", true);
  if (amount !== null && !MONEY_PATTERN.test(amount)) issues.push({ path: "transaction_amount", message: "An amount such as 500 or 500.50", code: "invalid_amount" });
  if (issues.length > 0) throw new ValidationAppError("Request validation failed", { issues });
  const raw = Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined));
  return { transactionId, tradeStatus: tradeStatus as string, amount: normalizeAmount(amount as string), vendorRef: vendorRef as string, raw };
}

export type ChechePayServiceUpdateInput = z.output<typeof chechePayServiceUpdateSchema>;

// One contract per endpoint (see middleware/validate.ts).
export const getChechePayServiceRequest = { params: organizationIdParamsSchema } satisfies RequestContract;
export const updateChechePayServiceRequest = { params: organizationIdParamsSchema, body: chechePayServiceUpdateSchema } satisfies RequestContract;
export const listPublicPaymentOptionsRequest = { params: publicEventParamsSchema } satisfies RequestContract;
export const getPublicOrderRequest = { params: publicOrderParamsSchema, headers: orderTokenHeadersSchema } satisfies RequestContract;
export const startPublicPaymentRequest = { params: publicOrderParamsSchema, headers: orderTokenHeadersSchema } satisfies RequestContract;
export const chechePayNotifyPostRequest = { body: chechePayNotificationSchema } satisfies RequestContract;
export const chechePayNotifyGetRequest = { query: chechePayNotificationSchema } satisfies RequestContract;
