import { parseArgs } from "node:util";
import { z } from "zod";
import { sequelize } from "../db.js";
import "../models/index.js";
import { platformBootstrapService } from "../services/platform-bootstrap.service.js";

/**
 * Operational script template: parse args strictly, preview by default, mutate only with --confirm,
 * print machine-readable JSON, always close the pool, set a non-zero exit code on failure.
 *
 *   npm run bootstrap:super-admin -- --user-id <central-auth-uuid> [--confirm]
 */
try {
  const { values } = parseArgs({
    strict: true,
    options: { "user-id": { type: "string" }, confirm: { type: "boolean", default: false } },
  });
  const parsedUserId = z.uuid().safeParse(values["user-id"]);
  if (!parsedUserId.success) throw new Error("--user-id must be a Central Auth user UUID");
  const userId = parsedUserId.data;

  const result = await platformBootstrapService.assignSuperAdmin(userId, { apply: values.confirm });
  console.log(JSON.stringify({ mode: values.confirm ? "apply" : "preview", userId, ...result }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  await sequelize.close();
}
