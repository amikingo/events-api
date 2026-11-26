import { z } from "zod";
import type { RequestContract } from "../middleware/validate.js";
import { organizationIdParamsSchema } from "./common.js";

/**
 * An organizer's Cheche Pay v2 keys (Phase 7 step 3b), platform scope only. The shape is checked here; the key's
 * format (sk_test_ / sk_live_, never pk_) is checked by the service so its message can say what went wrong.
 * - secret_key: required the first time; sent again, it replaces the key.
 * - webhook_secret: a string sets it, null clears it, left out keeps it.
 * - is_active: false stops new payments (payments already started can still be verified).
 */
export const chechePayCredentialSaveSchema = z
  .strictObject({
    secret_key: z.string().trim().min(1).max(250).optional(),
    webhook_secret: z.string().trim().min(1).max(250).nullable().optional(),
    is_active: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Send at least one field");

export type ChechePayCredentialSaveInput = z.output<typeof chechePayCredentialSaveSchema>;

// One contract per endpoint (see middleware/validate.ts).
export const getChechePayCredentialRequest = { params: organizationIdParamsSchema } satisfies RequestContract;
export const saveChechePayCredentialRequest = { params: organizationIdParamsSchema, body: chechePayCredentialSaveSchema } satisfies RequestContract;
export const deleteChechePayCredentialRequest = { params: organizationIdParamsSchema } satisfies RequestContract;
export const checkChechePayCredentialRequest = { params: organizationIdParamsSchema } satisfies RequestContract;
