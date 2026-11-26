import { z } from "zod";
import type { RequestContract } from "../middleware/validate.js";
import type { PaymentCaseKind, PaymentCaseResolution, PaymentCaseStatus } from "../models/payment-case.js";
import { moneyAmountSchema, organizationIdParamsSchema, paginationQuerySchema, uuidSchema } from "./common.js";

/**
 * Payment cases (Phase 8 step 3), organization scope, the Payments module. Staff list open cases, read one with its
 * order and payment attempt, and record the outcome after moving any money by hand in the organizer's merchant
 * account: REFUNDED needs the refunded amount, its currency and the merchant's refund reference; CLOSED_WITHOUT_REFUND
 * needs a note saying why.
 */
const KINDS = ["REFUND_REQUIRED", "PAID_TWICE", "AMOUNT_MISMATCH", "TICKET_RETURN"] as const satisfies readonly PaymentCaseKind[];
const STATUSES = ["OPEN", "RESOLVED"] as const satisfies readonly PaymentCaseStatus[];
const RESOLUTIONS = ["REFUNDED", "CLOSED_WITHOUT_REFUND"] as const satisfies readonly PaymentCaseResolution[];

export const paymentCaseListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(STATUSES).optional(),
  kind: z.enum(KINDS).optional(),
  event_id: uuidSchema.optional(),
});

export const paymentCaseParamsSchema = organizationIdParamsSchema.extend({ caseId: uuidSchema });

export const paymentCaseResolveSchema = z
  .strictObject({
    resolution: z.enum(RESOLUTIONS),
    refunded_amount: moneyAmountSchema.optional(),
    refunded_currency: z
      .string()
      .trim()
      .transform((value) => value.toUpperCase())
      .pipe(z.string().regex(/^[A-Z]{3}$/, "A three-letter currency code, e.g. ETB"))
      .optional(),
    merchant_reference: z.string().trim().min(1).max(255).optional(),
    note: z.string().trim().min(1).max(1000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.resolution === "REFUNDED") {
      if (value.refunded_amount === undefined || Number(value.refunded_amount) <= 0) ctx.addIssue({ code: "custom", path: ["refunded_amount"], message: "The amount refunded, above zero" });
      if (value.refunded_currency === undefined) ctx.addIssue({ code: "custom", path: ["refunded_currency"], message: "The refund's currency" });
      if (value.merchant_reference === undefined) ctx.addIssue({ code: "custom", path: ["merchant_reference"], message: "The refund reference from the merchant account" });
    }
    if (value.resolution === "CLOSED_WITHOUT_REFUND" && value.note === undefined) {
      ctx.addIssue({ code: "custom", path: ["note"], message: "Say why the case is closed without a refund" });
    }
  });

export type PaymentCaseListQuery = z.output<typeof paymentCaseListQuerySchema>;
export type PaymentCaseResolveInput = z.output<typeof paymentCaseResolveSchema>;

// One contract per endpoint (see middleware/validate.ts).
export const listPaymentCasesRequest = { params: organizationIdParamsSchema, query: paymentCaseListQuerySchema } satisfies RequestContract;
export const getPaymentCaseRequest = { params: paymentCaseParamsSchema } satisfies RequestContract;
export const resolvePaymentCaseRequest = { params: paymentCaseParamsSchema, body: paymentCaseResolveSchema } satisfies RequestContract;
