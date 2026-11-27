import type { Request, Response } from "express";
import { getValidated } from "../middleware/validate.js";
import { staffAccountService } from "../services/staff-account.service.js";
import { sendSuccess } from "../utils/http.js";
import { changeStaffPasswordRequest, staffForgotPasswordRequest, staffResetPasswordRequest, updateOwnStaffProfileRequest } from "../validators/auth.js";
import { getStaffAuth } from "./helpers.js";

/** A staff member's own account (Phase 10): names, password, forgot password. */
async function updateOwnProfile(req: Request, res: Response): Promise<void> {
  const { body } = getValidated(req, updateOwnStaffProfileRequest);
  const result = await staffAccountService.updateOwnNames(getStaffAuth(req), body);
  sendSuccess(res, 200, result, result.changed ? "Your names were updated" : "Nothing changed");
}

async function changePassword(req: Request, res: Response): Promise<void> {
  const { body } = getValidated(req, changeStaffPasswordRequest);
  sendSuccess(res, 200, await staffAccountService.changePassword(getStaffAuth(req), body), "Your password was changed");
}

/** Always the same reply, whether or not the mobile has staff access. */
async function forgotPassword(req: Request, res: Response): Promise<void> {
  const { body } = getValidated(req, staffForgotPasswordRequest);
  const result = await staffAccountService.requestPasswordReset(body);
  sendSuccess(res, 200, result, result.message);
}

async function resetPassword(req: Request, res: Response): Promise<void> {
  const { body } = getValidated(req, staffResetPasswordRequest);
  sendSuccess(res, 200, await staffAccountService.resetPassword(body), "Password reset. You can sign in with your new password");
}

export const staffAccountController = { updateOwnProfile, changePassword, forgotPassword, resetPassword };
