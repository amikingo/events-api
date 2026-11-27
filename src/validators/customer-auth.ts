import { z } from "zod";
import type { RequestContract } from "../middleware/validate.js";
import { mobileSchema } from "./auth.js";

/**
 * Guest accounts (Phase 6): Cheche accounts in auth-cheche, used on the public site. Mobiles are Ethiopian and
 * normalized to +251… (the same rule as staff sign-in). The SMS code is sent as `otp`, which every log redacts.
 * auth-cheche decides what a valid password is; this only bounds the size.
 */
const nameSchema = z.string().trim().min(1).max(100);
const passwordSchema = z.string().min(1).max(128);
const otpSchema = z.string().trim().min(4).max(10);

export const customerSignUpSchema = z.strictObject({
  first_name: nameSchema,
  last_name: nameSchema,
  mobile: mobileSchema,
  password: passwordSchema,
});

/** The code from the SMS, plus the password again: the account is confirmed, then signed in with the password. */
export const customerConfirmSignUpSchema = z.strictObject({ mobile: mobileSchema, otp: otpSchema, password: passwordSchema });

export const customerSendCodeSchema = z.strictObject({ mobile: mobileSchema });

export const customerCodeLoginSchema = z.strictObject({ mobile: mobileSchema, otp: otpSchema });

export const customerPasswordLoginSchema = z.strictObject({ mobile: mobileSchema, password: passwordSchema });

export type CustomerSignUpInput = z.output<typeof customerSignUpSchema>;
export type CustomerConfirmSignUpInput = z.output<typeof customerConfirmSignUpSchema>;
export type CustomerCodeLoginInput = z.output<typeof customerCodeLoginSchema>;
export type CustomerPasswordLoginInput = z.output<typeof customerPasswordLoginSchema>;

// One contract per endpoint (see middleware/validate.ts).
export const customerSignUpRequest = { body: customerSignUpSchema } satisfies RequestContract;
export const customerConfirmSignUpRequest = { body: customerConfirmSignUpSchema } satisfies RequestContract;
export const customerResendSignUpCodeRequest = { body: customerSendCodeSchema } satisfies RequestContract;
export const customerSendCodeRequest = { body: customerSendCodeSchema } satisfies RequestContract;
export const customerCodeLoginRequest = { body: customerCodeLoginSchema } satisfies RequestContract;
export const customerPasswordLoginRequest = { body: customerPasswordLoginSchema } satisfies RequestContract;
export const customerRefreshRequest = {} satisfies RequestContract;
export const customerLogoutRequest = {} satisfies RequestContract;
export const currentCustomerRequest = {} satisfies RequestContract;

/** Phase 10: a signed-in guest's own names; middlename "" or null clears it. */
export const customerProfileUpdateSchema = z.strictObject({
  firstname: z.string().trim().min(1).max(100),
  middlename: z.string().trim().max(100).nullable().optional(),
  lastname: z.string().trim().min(1).max(100),
});
export const updateCustomerProfileRequest = { body: customerProfileUpdateSchema } satisfies RequestContract;
