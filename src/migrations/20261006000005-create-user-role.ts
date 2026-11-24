import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      "user_role",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: queryInterface.sequelize.fn("gen_random_uuid") },
        user_id: { type: DataTypes.UUID, allowNull: false }, // Central Auth user id: logical reference, no FK
        role_id: { type: DataTypes.UUID, allowNull: false },
        organization_id: { type: DataTypes.UUID, allowNull: true },
        branch_id: { type: DataTypes.UUID, allowNull: true },
        is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        created_by: { type: DataTypes.UUID, allowNull: true },
        updated_by: { type: DataTypes.UUID, allowNull: true },
      },
      { transaction },
    );

    await queryInterface.addConstraint("user_role", {
      fields: ["role_id"],
      type: "foreign key",
      name: "fk_user_role_role_id",
      references: { table: "role", field: "id" },
      onUpdate: "CASCADE",
      onDelete: "RESTRICT",
      transaction,
    });
    await queryInterface.addConstraint("user_role", {
      fields: ["organization_id"],
      type: "foreign key",
      name: "fk_user_role_organization_id",
      references: { table: "organization", field: "id" },
      onUpdate: "CASCADE",
      onDelete: "RESTRICT",
      transaction,
    });
    await queryInterface.sequelize.query(
      `ALTER TABLE "user_role"
         ADD CONSTRAINT "fk_user_role_organization_branch_id"
         FOREIGN KEY ("organization_id", "branch_id")
         REFERENCES "branch" ("organization_id", "id")
         ON UPDATE CASCADE ON DELETE RESTRICT,
         ADD CONSTRAINT "ck_user_role_branch_requires_organization"
         CHECK ("branch_id" IS NULL OR "organization_id" IS NOT NULL)`,
      { transaction },
    );

    // One row per (user, role, scope) -- three partial indexes because NULLs never collide in UNIQUE.
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX "uq_user_role_platform" ON "user_role" ("user_id", "role_id")
         WHERE "organization_id" IS NULL;
       CREATE UNIQUE INDEX "uq_user_role_organization" ON "user_role" ("user_id", "role_id", "organization_id")
         WHERE "organization_id" IS NOT NULL AND "branch_id" IS NULL;
       CREATE UNIQUE INDEX "uq_user_role_branch" ON "user_role" ("user_id", "role_id", "organization_id", "branch_id")
         WHERE "branch_id" IS NOT NULL;`,
      { transaction },
    );
    await queryInterface.addIndex("user_role", ["user_id", "is_active"], { name: "idx_user_role_user_active", transaction });
    await queryInterface.addIndex("user_role", ["organization_id", "is_active"], {
      name: "idx_user_role_organization_active",
      transaction,
    });

    // Integrity backstop (services reproduce these rules with friendly errors first):
    //  - platform rows use platform roles; tenant rows use roles of the same organization
    //  - one user is either platform staff or staff of exactly one organization
    await queryInterface.sequelize.query(
      `CREATE OR REPLACE FUNCTION fn_user_role_scope_guard() RETURNS trigger
       LANGUAGE plpgsql AS $$
       DECLARE
         v_role_organization_id uuid;
       BEGIN
         SELECT organization_id INTO v_role_organization_id FROM role WHERE id = NEW.role_id;
         IF NOT FOUND THEN
           RAISE EXCEPTION 'user_role.role_id % does not exist', NEW.role_id USING ERRCODE = '23503';
         END IF;

         IF v_role_organization_id IS DISTINCT FROM NEW.organization_id THEN
           RAISE EXCEPTION 'Assignment scope must match the role scope' USING ERRCODE = '23514';
         END IF;

         IF EXISTS (
           SELECT 1 FROM user_role ur
            WHERE ur.user_id = NEW.user_id
              AND ur.id IS DISTINCT FROM NEW.id
              AND ur.organization_id IS DISTINCT FROM NEW.organization_id
         ) THEN
           RAISE EXCEPTION 'A user cannot hold assignments in different scopes/organizations' USING ERRCODE = '23514';
         END IF;

         RETURN NEW;
       END;
       $$;

       CREATE TRIGGER trg_user_role_scope_guard
         BEFORE INSERT OR UPDATE ON user_role
         FOR EACH ROW EXECUTE FUNCTION fn_user_role_scope_guard();`,
      { transaction },
    );
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(
      `DROP TRIGGER IF EXISTS trg_user_role_scope_guard ON user_role;
       DROP FUNCTION IF EXISTS fn_user_role_scope_guard();`,
      { transaction },
    );
    await queryInterface.dropTable("user_role", { transaction });
  });
};
