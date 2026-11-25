import type { Request, Response } from "express";
import { getValidated } from "../middleware/validate.js";
import { authService } from "../services/auth.service.js";
import { customerAuthService, type CustomerSessionResult } from "../services/customer-auth.service.js";
import { clearRefreshCookie, getRefreshCookie, setRefreshCookie } from "../utils/auth-refresh-cookies.js";
import { sendSuccess } from "../utils/http.js";
import {
  customerCodeLoginRequest,
  customerConfirmSignUpRequest,
  customerPasswordLoginRequest,
  customerResendSignUpCodeRequest,
  customerSendCodeRequest,
  customerSignUpRequest,
} from "../validators/customer-auth.js";
import { getCustomerAuth } from "./helpers.js";

/** Guest accounts (Phase 6). The refresh token goes only into the HttpOnly cookie on /v1/auth/customer. */
function sendSession(res: Response, result: CustomerSessionResult, message: string): void {
  if (result.refreshCookie) setRefreshCookie(res, "customer", result.refreshCookie.token, result.refreshCookie.maxAgeSeconds);
  sendSuccess(res, 200, result.data, message);
}

async function signUp(req: Request, res: Response): Promise<void> {
  const { body } = getValidated(req, customerSignUpRequest);
  await customerAuthService.signUp(body);
  sendSuccess(res, 201, { mobile: body.mobile }, "Account created. Enter the code we sent by SMS");
}

async function confirmSignUp(req: Request, res: Response): Promise<void> {
  const { body } = getValidated(req, customerConfirmSignUpRequest);
  sendSession(res, await customerAuthService.confirmSignUp(body), "Account confirmed");
}

async function resendSignUpCode(req: Request, res: Response): Promise<void> {
  const { body } = getValidated(req, customerResendSignUpCodeRequest);
  await customerAuthService.sendCode(body.mobile);
  sendSuccess(res, 200, { mobile: body.mobile }, "A new code was sent by SMS");
}

async function sendCode(req: Request, res: Response): Promise<void> {
  const { body } = getValidated(req, customerSendCodeRequest);
  await customerAuthService.sendCode(body.mobile);
  sendSuccess(res, 200, { mobile: body.mobile }, "A code was sent by SMS");
}

async function loginWithCode(req: Request, res: Response): Promise<void> {
  const { body } = getValidated(req, customerCodeLoginRequest);
  sendSession(res, await customerAuthService.loginWithCode(body), "Signed in");
}

async function loginWithPassword(req: Request, res: Response): Promise<void> {
  const { body } = getValidated(req, customerPasswordLoginRequest);
  sendSession(res, await customerAuthService.loginWithPassword(body), "Signed in");
}

async function refreshSession(req: Request, res: Response): Promise<void> {
  try {
    sendSession(res, await customerAuthService.refreshSession(getRefreshCookie(req, "customer")), "Session refreshed");
  } catch (error) {
    clearRefreshCookie(res, "customer");
    throw error;
  }
}

async function logout(req: Request, res: Response): Promise<void> {
  const refreshToken = getRefreshCookie(req, "customer");
  // Clear first: the cookie goes even if anything below fails unexpectedly.
  clearRefreshCookie(res, "customer");
  const revoked = await authService.revokeCentralSession(refreshToken);
  sendSuccess(res, 200, { revoked }, "Signed out");
}

async function getCurrentCustomer(req: Request, res: Response): Promise<void> {
  sendSuccess(res, 200, await customerAuthService.getCurrentCustomer(getCustomerAuth(req)), "Current guest fetched");
}

export const customerAuthController = {
  signUp,
  confirmSignUp,
  resendSignUpCode,
  sendCode,
  loginWithCode,
  loginWithPassword,
  refreshSession,
  logout,
  getCurrentCustomer,
};
