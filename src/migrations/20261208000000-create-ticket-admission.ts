import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Phase 8 step 2: one admission per ticket, for the whole event (online, single entry). A gate scan or a typed code
 * records who admitted the ticket and when. The registration itself never changes, so its place stays taken.
 * - registration_id is unique: a ticket can be admitted once, enforced by Postgres even if two gates race.
 * - idempotency_key (unique per organization) is the gate request's retry key: the same request again finds this row
 *   and gets its original result.
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      "ticket_admission",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: queryInterface.sequelize.fn("gen_random_uuid") },
        organization_id: { type: DataTypes.UUID, allowNull: false },
        event_id: { type: DataTypes.UUID, allowNull: false },
        registration_id: { type: DataTypes.UUID, allowNull: false },
        admitted_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        admitted_by: { type: DataTypes.UUID, allowNull: false },
        idempotency_key: { type: DataTypes.STRING(128), allowNull: false },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
      },
      { transaction },
    );
    await queryInterface.sequelize.query(
      `ALTER TABLE "ticket_admission"
         ADD CONSTRAINT "fk_ticket_admission_organization_event" FOREIGN KEY ("organization_id", "event_id")
           REFERENCES "event" ("organization_id", "id") ON UPDATE CASCADE ON DELETE RESTRICT,
         ADD CONSTRAINT "fk_ticket_admission_organization_registration" FOREIGN KEY ("organization_id", "registration_id")
           REFERENCES "registration" ("organization_id", "id") ON UPDATE CASCADE ON DELETE RESTRICT,
         ADD CONSTRAINT "uq_ticket_admission_registration" UNIQUE ("registration_id"),
         ADD CONSTRAINT "uq_ticket_admission_organization_key" UNIQUE ("organization_id", "idempotency_key")`,
      { transaction },
    );
    await queryInterface.addIndex("ticket_admission", ["organization_id", "event_id"], { name: "idx_ticket_admission_organization_event", transaction });
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable("ticket_admission", { transaction });
  });
};
