import { parseArgs } from "node:util";
import { z } from "zod";
import { env } from "../config/env.js";
import { sequelize } from "../db.js";
import { AppError } from "../errors/app-errors.js";
import "../models/index.js";
import { devStaffTokenService } from "../services/dev-staff-token.service.js";

/**
 * DEVELOPMENT ONLY (refuses unless NODE_ENV=development). Prints a normal 15-minute staff access token for
 * one of the person's active assignments, so staff screens work without auth-cheche. Treat the token like a
 * password: use it locally, never paste it into chat, tickets or commits.
 *
 *   npm run dev:staff-token -- --user-id <central-auth-uuid> [--assignment-id <uuid>]
 */
try {
  const { values } = parseArgs({
    strict: true,
    options: { "user-id": { type: "string" }, "assignment-id": { type: "string" } },
  });
  const userId = z.uuid().safeParse(values["user-id"]);
  if (!userId.success) throw new Error("--user-id must be a Central Auth user UUID");
  const assignmentId = values["assignment-id"] === undefined ? undefined : z.uuid().safeParse(values["assignment-id"]);
  if (assignmentId && !assignmentId.success) throw new Error("--assignment-id must be a UUID");

  const result = await devStaffTokenService.issueDevelopmentStaffToken({
    userId: userId.data,
    assignmentId: assignmentId?.data,
    environment: env.NODE_ENV,
  });
  console.log(JSON.stringify({ tokenType: "Bearer", ...result }, null, 2));
} catch (error) {
  const detail = error instanceof AppError ? { code: error.code, details: error.details } : {};
  console.error(JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error), ...detail }, null, 2));
  process.exitCode = 1;
} finally {
  await sequelize.close();
}
