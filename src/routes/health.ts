import { Router } from "express";
import { healthController } from "../controllers/health.controller.js";

/** Unversioned infrastructure probes (Kubernetes liveness/readiness). */
export const healthRouter = Router();

healthRouter.get("/live", healthController.live);
healthRouter.get("/ready", healthController.ready);
