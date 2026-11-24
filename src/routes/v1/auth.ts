import { Router } from "express";
import { authController } from "../../controllers/auth.controller.js";
import { noStore, requireTrustedRefreshOrigin } from "../../middleware/auth-refresh-security.js";
import { requireStaffAuthentication } from "../../middleware/authentication.js";
import { authLoginLimiter, authRefreshLimiter } from "../../middleware/rate-limit.js";
import { validate } from "../../middleware/validate.js";
import {
  currentStaffSessionRequest,
  staffLoginRequest,
  staffLogoutRequest,
  staffRefreshRequest,
  staffSwitchAssignmentRequest,
} from "../../validators/auth.js";

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
