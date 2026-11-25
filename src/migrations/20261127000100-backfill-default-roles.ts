import type { QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Repairs organizations created through POST /v1/organizations before it made the default roles (fixed 25 November
 * 2026): every organization that has no role at all gets OWNER and VIEWER, with the grants utils/default-roles.ts
 * gives a new organization today. Organizations that already have any role are never touched. Data only.
 *
 * The grants are written out here, not read from the code, so this migration keeps doing the same thing even if the
 * defaults change later (later changes come with their own migrations, as 20261126000004 and 20261127000000 did).
 */
export const BACKFILL_GRANTS: Array<[role: "OWNER" | "VIEWER", module: string, view: boolean, create: boolean, update: boolean]> = [
  ["OWNER", "ORGANIZATIONS", true, false, true],
  ["OWNER", "BRANCHES", true, true, true],
  ["OWNER", "ROLES", true, false, false],
  ["OWNER", "USER_ROLES", true, true, true],
  ["OWNER", "EVENTS", true, true, true],
  ["OWNER", "CUSTOMERS", true, true, true],
  ["OWNER", "REGISTRATIONS", true, true, true],
  ["VIEWER", "ORGANIZATIONS", true, false, false],
  ["VIEWER", "BRANCHES", true, false, false],
  ["VIEWER", "EVENTS", true, false, false],
  ["VIEWER", "CUSTOMERS", true, false, false],
  ["VIEWER", "REGISTRATIONS", true, false, false],
];

export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  const grantValues = BACKFILL_GRANTS.map(([role, module, view, create, update]) => `('${role}', '${module}', ${view}, ${create}, ${update})`).join(",\n         ");
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(
      `WITH bare AS (
         SELECT o."id" FROM "organization" o
          WHERE NOT EXISTS (SELECT 1 FROM "role" r WHERE r."organization_id" = o."id")
       ),
       new_roles AS (
         INSERT INTO "role" ("organization_id", "code", "name", "description", "is_active")
         SELECT b."id", t."code", t."name", t."description", true
           FROM bare b
           CROSS JOIN (VALUES ('OWNER', 'Owner', 'Runs the organization'), ('VIEWER', 'Viewer', 'Read-only access'))
             AS t("code", "name", "description")
         RETURNING "id", "code"
       )
       INSERT INTO "role_module_access" ("role_id", "module_id", "can_view", "can_create", "can_update")
       SELECT nr."id", m."id", g."can_view", g."can_create", g."can_update"
         FROM new_roles nr
         JOIN (VALUES
         ${grantValues}) AS g("role_code", "module_code", "can_view", "can_create", "can_update")
           ON g."role_code" = nr."code"
         JOIN "module" m ON m."code" = g."module_code"`,
      { transaction },
    );
  });
};

/** Nothing to undo safely: by then the roles may hold staff assignments. Remove such roles by hand if ever needed. */
export const down: MigrationFn<QueryInterface> = () => Promise.resolve();
