import type { QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

type SeedAction = "view" | "create" | "update" | "export";

/**
 * Phase 2d: the OWNER and VIEWER templates, both for new organizations, as utils/default-roles.ts defines the roles
 * on the day this migration was written. Written out (never imported), so later edits to the code can't change what
 * this already-applied migration did; tests/role-template.service.test.ts checks it equals DEFAULT_TENANT_ROLES.
 */
export const SEED_ROLE_TEMPLATES: ReadonlyArray<{
  code: string;
  name: string;
  description: string;
  grants: ReadonlyArray<[module: string, actions: readonly SeedAction[]]>;
}> = [
  {
    code: "OWNER",
    name: "Owner",
    description: "Runs the organization",
    grants: [
      ["ORGANIZATIONS", ["view", "update"]],
      ["BRANCHES", ["view", "create", "update"]],
      ["ROLES", ["view", "create", "update"]],
      ["USER_ROLES", ["view", "create", "update"]],
      ["EVENTS", ["view", "create", "update"]],
      ["CUSTOMERS", ["view", "create", "update"]],
      ["REGISTRATIONS", ["view", "create", "update", "export"]],
    ],
  },
  {
    code: "VIEWER",
    name: "Viewer",
    description: "Read-only access",
    grants: [
      ["ORGANIZATIONS", ["view"]],
      ["BRANCHES", ["view"]],
      ["EVENTS", ["view"]],
      ["CUSTOMERS", ["view"]],
      ["REGISTRATIONS", ["view"]],
    ],
  },
];

export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    for (const template of SEED_ROLE_TEMPLATES) {
      await queryInterface.sequelize.query(
        `INSERT INTO "role_template" ("code", "name", "description", "is_active", "for_new_organizations")
         VALUES (:code, :name, :description, true, true)
         ON CONFLICT ("code") DO NOTHING`,
        { replacements: { code: template.code, name: template.name, description: template.description }, transaction },
      );
      for (const [module, actions] of template.grants) {
        await queryInterface.sequelize.query(
          `INSERT INTO "role_template_module_access" ("role_template_id", "module_id", "can_view", "can_create", "can_update", "can_export")
           SELECT t."id", m."id", :view, :create, :update, :export
             FROM "role_template" t CROSS JOIN "module" m
            WHERE t."code" = :code AND m."code" = :module
           ON CONFLICT ("role_template_id", "module_id") DO NOTHING`,
          {
            replacements: {
              code: template.code,
              module,
              view: actions.includes("view"),
              create: actions.includes("create"),
              update: actions.includes("update"),
              export: actions.includes("export"),
            },
            transaction,
          },
        );
      }
    }
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(`DELETE FROM "role_template" WHERE "code" IN ('OWNER', 'VIEWER')`, { transaction });
  });
};
