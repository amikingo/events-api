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

/**
 * auth-cheche sign-in with mobile OR email, plus password: exactly one of the two.
 * PIN sign-in is legacy: a body that still sends `pin` is rejected (strict).
 */
export const staffLoginSchema = z
  .strictObject({
    mobile: mobileSchema.optional(),
    // Not lower-cased: auth-cheche may compare emails exactly.
    email: z.email().max(254).optional(),
    password: z.string().min(1).max(128),
    device_id: z.string().trim().min(1).max(128).optional(),
    device_name: z.string().trim().min(1).max(128).optional(),
    platform: z.enum(["ios", "android", "web"]).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.mobile === undefined && value.email === undefined) {
      ctx.addIssue({ code: "custom", path: ["mobile"], message: "Send either mobile or email" });
    } else if (value.mobile !== undefined && value.email !== undefined) {
      ctx.addIssue({ code: "custom", path: ["email"], message: "Send either mobile or email, not both" });
    }
  });

/** Optional body. Express 5 leaves req.body undefined when nothing was sent. */
export const staffRefreshSchema = z.strictObject({ assignment_id: uuidSchema.optional() }).optional();

export const staffSwitchAssignmentSchema = z.strictObject({ assignment_id: uuidSchema });

export type StaffLoginInput = z.output<typeof staffLoginSchema>;
export type StaffRefreshInput = z.output<typeof staffRefreshSchema>;
export type StaffSwitchAssignmentInput = z.output<typeof staffSwitchAssignmentSchema>;

/** Phase 10: names as auth-cheche keeps them; middlename "" or null clears it. */
const nameSchema = z.string().trim().min(1).max(100);
export const staffOwnProfileSchema = z.strictObject({ firstname: nameSchema, middlename: z.string().trim().max(100).nullable().optional(), lastname: nameSchema });

/** Phase 10: a new password: 8 to 128 characters (auth-cheche may ask for more), different from the current one. */
const newPasswordSchema = z.string().min(8, "At least 8 characters").max(128);
export const staffPasswordChangeSchema = z
  .strictObject({ old_password: z.string().min(1).max(128), new_password: newPasswordSchema })
  .refine((value) => value.old_password !== value.new_password, { path: ["new_password"], message: "The new password must be different from the current one" });

/** Phase 10: forgot password: the mobile the code goes to (only if it has staff access), then the code and a new password. */
export const staffForgotPasswordSchema = z.strictObject({ mobile: mobileSchema });
export const staffResetPasswordSchema = z.strictObject({ mobile: mobileSchema, otp: z.string().trim().min(4).max(12), new_password: newPasswordSchema });

export type StaffOwnProfileInput = z.output<typeof staffOwnProfileSchema>;

export const staffLoginRequest = { body: staffLoginSchema } satisfies RequestContract;
export const updateOwnStaffProfileRequest = { body: staffOwnProfileSchema } satisfies RequestContract;
export const changeStaffPasswordRequest = { body: staffPasswordChangeSchema } satisfies RequestContract;
export const staffForgotPasswordRequest = { body: staffForgotPasswordSchema } satisfies RequestContract;
export const staffResetPasswordRequest = { body: staffResetPasswordSchema } satisfies RequestContract;
export const staffRefreshRequest = { body: staffRefreshSchema } satisfies RequestContract;
export const staffLogoutRequest = {} satisfies RequestContract;
export const currentStaffSessionRequest = {} satisfies RequestContract;
export const staffSwitchAssignmentRequest = { body: staffSwitchAssignmentSchema } satisfies RequestContract;
