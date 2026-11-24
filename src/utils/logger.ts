import { pino } from "pino";
import { env } from "../config/env.js";
import { LOG_REDACT_PATHS } from "./redact.js";

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: LOG_REDACT_PATHS, censor: "[REDACTED]" },
  base: { service: "events-api" },
});
