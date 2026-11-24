import { parseArgs } from "node:util";
import { z } from "zod";
import { sequelize } from "../db.js";
import { AppError } from "../errors/app-errors.js";
import "../models/index.js";
import { organizationProvisioningService } from "../services/organization-provisioning.service.js";
import { slugSchema } from "../validators/organization.js";

/**
 * Creates an organization with its MAIN branch, the default OWNER and VIEWER roles, and the owner's
 * organization-wide assignment, in one transaction. Preview by default; writes only with --confirm.
 *
 *   npm run provision:organizer -- --name "Selam Events" --owner-user-id <central-auth-uuid> [--slug selam-events] [--confirm]
 *
 * A name with no Latin letters (e.g. Amharic) needs --slug.
 */
try {
  const { values } = parseArgs({
    strict: true,
    options: {
      name: { type: "string" },
      slug: { type: "string" },
      "owner-user-id": { type: "string" },
      confirm: { type: "boolean", default: false },
    },
  });
  const name = z.string().trim().min(1).max(255).safeParse(values.name);
  if (!name.success) throw new Error("--name is required (at most 255 characters)");
  const ownerUserId = z.uuid().safeParse(values["owner-user-id"]);
  if (!ownerUserId.success) throw new Error("--owner-user-id must be a Central Auth user UUID");
  const slug = values.slug === undefined ? undefined : slugSchema.safeParse(values.slug);
  if (slug && !slug.success) throw new Error("--slug must be lowercase words separated by single hyphens, e.g. selam-events");

  const result = await organizationProvisioningService.provisionOrganizer(
    { name: name.data, slug: slug?.data, ownerUserId: ownerUserId.data },
    null,
    { apply: values.confirm },
  );
  console.log(JSON.stringify({ mode: values.confirm ? "apply" : "preview", name: name.data, ...result }, null, 2));
} catch (error) {
  const detail = error instanceof AppError ? { code: error.code, details: error.details } : {};
  console.error(JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error), ...detail }, null, 2));
  process.exitCode = 1;
} finally {
  await sequelize.close();
}
