import { z } from "zod";
import type { RequestContract } from "../middleware/validate.js";
import { idempotencyKeySchema } from "./common.js";
import { eventParamsSchema } from "./event.js";

/**
 * Admission at the door (Phase 8 step 2). The body carries the scanned or typed ticket code: the QR payload is the
 * ticket's 8-character code (letters and digits without look-alikes), nothing else. Lower case and spaces are
 * accepted from a keyboard. The gate's Idempotency-Key is required, so a retried request returns its original result.
 */
export const checkInSchema = z.strictObject({
  code: z
    .string()
    .transform((value) => value.replace(/\s+/g, "").toUpperCase())
    .pipe(z.string().regex(/^[A-HJKMNP-Z2-9]{8}$/, "A ticket code: 8 letters and digits")),
});

export const checkInHeadersSchema = z.object({ "idempotency-key": idempotencyKeySchema });

export type CheckInBody = z.output<typeof checkInSchema>;

// One contract per endpoint (see middleware/validate.ts).
export const checkInRequest = { params: eventParamsSchema, headers: checkInHeadersSchema, body: checkInSchema } satisfies RequestContract;
