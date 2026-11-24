import type { Request, Response } from "express";
import { authService, type CentralSessionCookieAction } from "../services/auth.service.js";
import {
  clearRefreshCookie,
  clearStaffCentralSessionCookie,
  getRefreshCookie,
  getStaffCentralSessionCookie,
  setRefreshCookie,
  setStaffCentralSessionCookie,
} from "../utils/auth-refresh-cookies.js";
import { sendSuccess } from "../utils/http.js";
import { staffLoginRequest, staffRefreshRequest, staffSwitchAssignmentRequest } from "../validators/auth.js";
import { getValidated } from "../middleware/validate.js";
import { getStaffAuth } from "./helpers.js";

function applyCentralSessionCookie(res: Response, cookie: CentralSessionCookieAction): void {
  switch (cookie.action) {
    case "set":
      setStaffCentralSessionCookie(res, cookie.token, cookie.maxAgeSeconds);
      return;
    case "clear":
      clearStaffCentralSessionCookie(res);
      return;
    case "keep":
      return;
  }
}

async function staffLogin(req: Request, res: Response): Promise<void> {
  const { body } = getValidated(req, staffLoginRequest);
  const result = await authService.staffLogin(body);
  if (result.refreshCookie) setRefreshCookie(res, "staff", result.refreshCookie.token, result.refreshCookie.maxAgeSeconds);
  applyCentralSessionCookie(res, result.centralSessionCookie);
  // The upstream refresh token never reaches JavaScript: cookie only.
  sendSuccess(res, 200, result.data, "Staff authenticated");
}

async function refreshStaffSession(req: Request, res: Response): Promise<void> {
  const { body } = getValidated(req, staffRefreshRequest);
  try {
    const result = await authService.refreshStaffSession(body, getRefreshCookie(req, "staff"), getStaffCentralSessionCookie(req));
    if (result.refreshCookie) setRefreshCookie(res, "staff", result.refreshCookie.token, result.refreshCookie.maxAgeSeconds);
    applyCentralSessionCookie(res, result.centralSessionCookie);
    sendSuccess(res, 200, result.data, "Staff session refreshed");
  } catch (error) {
    if (authService.shouldClearRefreshCookie(error)) {
      clearRefreshCookie(res, "staff");
      clearStaffCentralSessionCookie(res);
    }
    throw error;
  }
}

async function staffLogout(req: Request, res: Response): Promise<void> {
  const refreshToken = getRefreshCookie(req, "staff");
  // Clear first: the cookies go even if anything below fails unexpectedly.
  clearRefreshCookie(res, "staff");
  clearStaffCentralSessionCookie(res);
  const revoked = await authService.revokeCentralSession(refreshToken);
  sendSuccess(res, 200, { revoked }, "Staff signed out");
}

async function getCurrentStaffSession(req: Request, res: Response): Promise<void> {
  const session = await authService.getCurrentStaffSession(getStaffAuth(req));
  sendSuccess(res, 200, session, "Current staff session fetched");
}

async function switchStaffAssignment(req: Request, res: Response): Promise<void> {
  const { body } = getValidated(req, staffSwitchAssignmentRequest);
  const result = await authService.switchStaffAssignment(body, getStaffAuth(req));
  sendSuccess(res, 200, result, "Staff assignment switched");
}

export const authController = { staffLogin, refreshStaffSession, staffLogout, getCurrentStaffSession, switchStaffAssignment };
