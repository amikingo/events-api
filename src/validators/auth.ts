import { z } from "zod";
import type { RequestContract } from "../middleware/validate.js";
import { normalizeEthiopianMobile } from "../utils/mobile.js";
import { uuidSchema } from "./common.js";

export const mobileSchema = z
  .string()
  .trim()
  .min(9)
  .max(20)
  .transform((value, ctx) => {
    const normalized = normalizeEthiopianMobile(value);
    if (!normalized) {
      ctx.addIssue({ code: "custom", message: "Unsupported mobile number format" });
      return z.NEVER;
    }
    return normalized;
  });

export const staffLoginSchema = z.strictObject({
  mobile: mobileSchema,
  password: z.string().min(1).max(256),
});

/** Optional body. Express 5 leaves req.body undefined when nothing was sent. */
export const staffRefreshSchema = z.strictObject({ assignment_id: uuidSchema.optional() }).optional();

export const staffSwitchAssignmentSchema = z.strictObject({ assignment_id: uuidSchema });

export type StaffLoginInput = z.output<typeof staffLoginSchema>;
export type StaffRefreshInput = z.output<typeof staffRefreshSchema>;
export type StaffSwitchAssignmentInput = z.output<typeof staffSwitchAssignmentSchema>;

export const staffLoginRequest = { body: staffLoginSchema } satisfies RequestContract;
export const staffRefreshRequest = { body: staffRefreshSchema } satisfies RequestContract;
export const staffLogoutRequest = {} satisfies RequestContract;
export const currentStaffSessionRequest = {} satisfies RequestContract;
export const staffSwitchAssignmentRequest = { body: staffSwitchAssignmentSchema } satisfies RequestContract;
