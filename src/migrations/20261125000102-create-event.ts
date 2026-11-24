import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * event (spec §5). Links to branch, client, venue and cover are optional; when present they must belong to the same
 * organization, which the composite foreign keys enforce (MATCH SIMPLE: a NULL link is not checked, so
 * branch_id = NULL means organization-wide even when a default MAIN branch exists).
 * Drafts may lack dates; a PUBLISHED or CLOSED event always has them (backstop for the publish rule in the service).
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      "event",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: queryInterface.sequelize.fn("gen_random_uuid") },
        organization_id: { type: DataTypes.UUID, allowNull: false },
        branch_id: { type: DataTypes.UUID, allowNull: true },
        customer_account_id: { type: DataTypes.UUID, allowNull: true },
        venue_id: { type: DataTypes.UUID, allowNull: true },
        cover_file_id: { type: DataTypes.UUID, allowNull: true },
        name: { type: DataTypes.STRING(255), allowNull: false },
        slug: { type: DataTypes.STRING(120), allowNull: false },
        description: { type: DataTypes.TEXT, allowNull: true },
        starts_at: { type: DataTypes.DATE, allowNull: true },
        ends_at: { type: DataTypes.DATE, allowNull: true },
        timezone: { type: DataTypes.STRING(64), allowNull: false },
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "DRAFT" },
        capacity: { type: DataTypes.INTEGER, allowNull: true },
        registration_opens_at: { type: DataTypes.DATE, allowNull: true },
        registration_closes_at: { type: DataTypes.DATE, allowNull: true },
        visibility: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "UNLISTED" },
        category: { type: DataTypes.STRING(80), allowNull: true },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        created_by: { type: DataTypes.UUID, allowNull: true },
        updated_by: { type: DataTypes.UUID, allowNull: true },
      },
      { transaction },
    );

    await queryInterface.addConstraint("event", {
      fields: ["organization_id"],
      type: "foreign key",
      name: "fk_event_organization_id",
      references: { table: "organization", field: "id" },
      onUpdate: "CASCADE",
      onDelete: "RESTRICT",
      transaction,
    });
    // Tenant-safe composite key: ticket_type and (Phase 4) registration reference (organization_id, id).
    await queryInterface.addConstraint("event", { fields: ["organization_id", "id"], type: "unique", name: "uq_event_organization_id_id", transaction });
    await queryInterface.addConstraint("event", { fields: ["organization_id", "slug"], type: "unique", name: "uq_event_organization_id_slug", transaction });

    // Optional links: each one must point at a row of the same organization.
    await queryInterface.sequelize.query(
      `ALTER TABLE "event"
         ADD CONSTRAINT "fk_event_organization_branch" FOREIGN KEY ("organization_id", "branch_id")
           REFERENCES "branch" ("organization_id", "id") ON UPDATE CASCADE ON DELETE RESTRICT,
         ADD CONSTRAINT "fk_event_organization_customer_account" FOREIGN KEY ("organization_id", "customer_account_id")
           REFERENCES "customer_account" ("organization_id", "id") ON UPDATE CASCADE ON DELETE RESTRICT,
         ADD CONSTRAINT "fk_event_organization_venue" FOREIGN KEY ("organization_id", "venue_id")
           REFERENCES "venue" ("organization_id", "id") ON UPDATE CASCADE ON DELETE RESTRICT,
         ADD CONSTRAINT "fk_event_organization_cover_file" FOREIGN KEY ("organization_id", "cover_file_id")
           REFERENCES "file" ("organization_id", "id") ON UPDATE CASCADE ON DELETE RESTRICT`,
      { transaction },
    );

    await queryInterface.sequelize.query(
      `ALTER TABLE "event"
         ADD CONSTRAINT "ck_event_slug_format" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
         ADD CONSTRAINT "ck_event_status" CHECK ("status" IN ('DRAFT', 'PUBLISHED', 'CLOSED', 'CANCELLED')),
         ADD CONSTRAINT "ck_event_visibility" CHECK ("visibility" IN ('PUBLIC', 'UNLISTED')),
         ADD CONSTRAINT "ck_event_capacity_positive" CHECK ("capacity" IS NULL OR "capacity" > 0),
         ADD CONSTRAINT "ck_event_dates_order" CHECK ("starts_at" IS NULL OR "ends_at" IS NULL OR "starts_at" < "ends_at"),
         ADD CONSTRAINT "ck_event_registration_window_order"
           CHECK ("registration_opens_at" IS NULL OR "registration_closes_at" IS NULL OR "registration_opens_at" < "registration_closes_at"),
         ADD CONSTRAINT "ck_event_published_has_dates"
           CHECK ("status" NOT IN ('PUBLISHED', 'CLOSED') OR ("starts_at" IS NOT NULL AND "ends_at" IS NOT NULL)),
         ADD CONSTRAINT "ck_event_timezone_present" CHECK (length("timezone") > 0)`,
      { transaction },
    );

    await queryInterface.addIndex("event", ["organization_id", "status"], { name: "idx_event_organization_status", transaction });
    // The public catalog (3c): published + public, by start time.
    await queryInterface.addIndex("event", ["status", "visibility", "starts_at"], { name: "idx_event_catalog", transaction });
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable("event", { transaction });
  });
};
