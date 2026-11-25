import type { AuthContext } from "../middleware/authentication.ts";
import type { PermissionResolution } from "../services/permission-resolution.service.ts";

declare global {
  namespace Express {
    interface Request {
      /** Trusted identity. Set only by authentication middleware; never read identity from body/query. */
      auth?: AuthContext;
      /** Parsed input. Set only by validate(contract); read it through getValidated(req, contract). */
      validated?: { params?: unknown; query?: unknown; body?: unknown; headers?: unknown };
      /** Set by requirePermission() for observability. */
      permissionResolution?: PermissionResolution;
    }
  }
}

export {};
