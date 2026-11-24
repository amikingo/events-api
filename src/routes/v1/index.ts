import { Router } from "express";
import { env } from "../../config/env.js";
import { authRouter } from "./auth.js";
import { branchesRouter } from "./branches.js";
import { docsRouter } from "./docs.js";
import { organizationsRouter } from "./organizations.js";

/** The v1 mount table. One literal registration per resource router; each router mounted exactly once. */
export const router = Router();

router.use("/auth", authRouter);
router.use("/organizations", organizationsRouter);
router.use("/organizations/:organizationId/branches", branchesRouter);

if (env.API_DOCS_ENABLED) {
  router.use(docsRouter); // GET /v1/openapi.json, /v1/docs
}
