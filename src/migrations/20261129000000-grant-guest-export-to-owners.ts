import type { QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/** What this migration adds to every tenant OWNER role (tests/default-roles.test.ts applies it on top of the earlier grants). */
export const GUEST_EXPORT_GRANT = Object.freeze({ role: "OWNER", module: "REGISTRATIONS", actions: ["export"] as const });

/**
 * Phase 4d: downloading an event's guest list as CSV is its own right (Guests › export), because the file holds every
 * guest's mobile. Existing tenant OWNER roles gain it; Viewers and custom roles get it only when someone gives it to
 * them. Matches utils/default-roles.ts for new organizations. Data only.
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(
      `INSERT INTO "role_module_access" ("role_id", "module_id", "can_view", "can_export")
       SELECT r."id", m."id", true, true
         FROM "role" r
         CROSS JOIN "module" m
        WHERE r."organization_id" IS NOT NULL AND r."code" = 'OWNER' AND m."code" = 'REGISTRATIONS'
       ON CONFLICT ("role_id", "module_id") DO UPDATE SET "can_view" = true, "can_export" = true, "updated_at" = now()`,
      { transaction },
    );
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(
      `UPDATE "role_module_access" SET "can_export" = false, "updated_at" = now()
        WHERE "module_id" IN (SELECT "id" FROM "module" WHERE "code" = 'REGISTRATIONS')
          AND "role_id" IN (SELECT "id" FROM "role" WHERE "organization_id" IS NOT NULL AND "code" = 'OWNER')`,
      { transaction },
    );
  });
};
