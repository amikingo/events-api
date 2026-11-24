import { parseArgs } from "node:util";
import { z } from "zod";
import { sequelize } from "../db.js";
import { AppError } from "../errors/app-errors.js";
import "../models/index.js";
import { organizationProvisioningService } from "../services/organization-provisioning.service.js";
import { organizationService } from "../services/organization.service.js";

/**
 * Gives a person a role in an organization, organization-wide or for one branch. Preview by default; writes
 * only with --confirm. An identical active assignment is left unchanged; an identical inactive one is reactivated.
 *
 *   npm run assign:staff -- --organization-slug selam-events --user-id <central-auth-uuid> --role-code VIEWER [--branch-code ADDIS] [--confirm]
 */
try {
  const { values } = parseArgs({
    strict: true,
    options: {
      "organization-slug": { type: "string" },
      "user-id": { type: "string" },
      "role-code": { type: "string" },
      "branch-code": { type: "string" },
      confirm: { type: "boolean", default: false },
    },
  });
  const organizationSlug = values["organization-slug"]?.trim();
  if (!organizationSlug) throw new Error("--organization-slug is required");
  const userId = z.uuid().safeParse(values["user-id"]);
  if (!userId.success) throw new Error("--user-id must be a Central Auth user UUID");
  const roleCode = values["role-code"]?.trim();
  if (!roleCode) throw new Error("--role-code is required, e.g. OWNER or VIEWER");

  const organization = await organizationService.getOrganizationBySlug(organizationSlug);
  const result = await organizationProvisioningService.assignStaff(
    { organizationId: organization.id, userId: userId.data, roleCode, branchCode: values["branch-code"] },
    null,
    { apply: values.confirm },
  );
  console.log(
    JSON.stringify(
      { mode: values.confirm ? "apply" : "preview", organizationId: organization.id, userId: userId.data, ...result },
      null,
      2,
    ),
  );
} catch (error) {
  const detail = error instanceof AppError ? { code: error.code, details: error.details } : {};
  console.error(JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error), ...detail }, null, 2));
  process.exitCode = 1;
} finally {
  await sequelize.close();
}
