import { Router } from "express";
import { healthRouter } from "./health.js";
import { router } from "./v1/index.js";

/** Version registry: each supported major version is mounted exactly once. */
export const rootRouter = Router();

rootRouter.use("/health", healthRouter);
rootRouter.use("/v1", router);
