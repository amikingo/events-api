import { Router } from "express";
import { authController } from "../../controllers/auth.controller.js";
import { customerAuthController } from "../../controllers/customer-auth.controller.js";
import { noStore, requireTrustedRefreshOrigin } from "../../middleware/auth-refresh-security.js";
import { requireCustomerAuthentication, requireStaffAuthentication } from "../../middleware/authentication.js";
import { authLoginLimiter, authRefreshLimiter, customerAuthLimiter, customerCodePerMobileLimiter } from "../../middleware/rate-limit.js";
import { validate } from "../../middleware/validate.js";
import {
  currentStaffSessionRequest,
  staffLoginRequest,
  staffLogoutRequest,
  staffRefreshRequest,
  staffSwitchAssignmentRequest,
} from "../../validators/auth.js";
import {
  currentCustomerRequest,
  customerCodeLoginRequest,
  customerConfirmSignUpRequest,
  customerLogoutRequest,
  customerPasswordLoginRequest,
  customerRefreshRequest,
  customerResendSignUpCodeRequest,
  customerSendCodeRequest,
  customerSignUpRequest,
} from "../../validators/customer-auth.js";

/** Mounted at /v1/auth. */
export const authRouter = Router();

authRouter.post("/staff/login", authLoginLimiter, noStore, validate(staffLoginRequest), authController.staffLogin);

// Cookie-authenticated: rate limit + trusted Origin + no-store.
authRouter.post(
  "/staff/refresh",
  authRefreshLimiter,
  requireTrustedRefreshOrigin,
  noStore,
  validate(staffRefreshRequest),
  authController.refreshStaffSession,
);

authRouter.post(
  "/staff/logout",
  authRefreshLimiter,
  requireTrustedRefreshOrigin,
  noStore,
  validate(staffLogoutRequest),
  authController.staffLogout,
);

authRouter.get("/staff/me", requireStaffAuthentication, validate(currentStaffSessionRequest), authController.getCurrentStaffSession);

authRouter.post(
  "/staff/switch-assignment",
  requireStaffAuthentication,
  validate(staffSwitchAssignmentRequest),
  authController.switchStaffAssignment,
);

// --- Guest accounts (Phase 6): Cheche accounts on the public site ----------------------------------------------
// Sign-up sends an SMS code too, so it shares the per-mobile code limit with /code and /signup/resend.

authRouter.post(
  "/customer/signup",
  customerAuthLimiter,
  customerCodePerMobileLimiter,
  noStore,
  validate(customerSignUpRequest),
  customerAuthController.signUp,
);

authRouter.post("/customer/signup/confirm", customerAuthLimiter, noStore, validate(customerConfirmSignUpRequest), customerAuthController.confirmSignUp);

authRouter.post(
  "/customer/signup/resend",
  customerAuthLimiter,
  customerCodePerMobileLimiter,
  noStore,
  validate(customerResendSignUpCodeRequest),
  customerAuthController.resendSignUpCode,
);

authRouter.post(
  "/customer/code",
  customerAuthLimiter,
  customerCodePerMobileLimiter,
  noStore,
  validate(customerSendCodeRequest),
  customerAuthController.sendCode,
);

authRouter.post("/customer/login/code", customerAuthLimiter, noStore, validate(customerCodeLoginRequest), customerAuthController.loginWithCode);

authRouter.post(
  "/customer/login/password",
  customerAuthLimiter,
  noStore,
  validate(customerPasswordLoginRequest),
  customerAuthController.loginWithPassword,
);

// Cookie-authenticated, like staff: rate limit + trusted Origin + no-store.
authRouter.post(
  "/customer/refresh",
  authRefreshLimiter,
  requireTrustedRefreshOrigin,
  noStore,
  validate(customerRefreshRequest),
  customerAuthController.refreshSession,
);

authRouter.post(
  "/customer/logout",
  authRefreshLimiter,
  requireTrustedRefreshOrigin,
  noStore,
  validate(customerLogoutRequest),
  customerAuthController.logout,
);

authRouter.get("/customer/me", requireCustomerAuthentication, validate(currentCustomerRequest), customerAuthController.getCurrentCustomer);
