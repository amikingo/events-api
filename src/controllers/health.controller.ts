import type { Request, Response } from "express";
import { healthService } from "../services/health.service.js";

/** Liveness: the process is up. No dependencies, never fails while the event loop runs. */
function live(_req: Request, res: Response): void {
  res.status(200).json({ status: "ok" });
}

/** Readiness: dependencies reachable and not draining. 503 takes the pod out of rotation. */
async function ready(_req: Request, res: Response): Promise<void> {
  res.status(200).json(await healthService.checkReadiness());
}

export const healthController = { live, ready };
