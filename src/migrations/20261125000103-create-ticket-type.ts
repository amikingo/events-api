import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * ticket_type (spec §7): a free registration category for one event. The code is unique within the event.
 * UNIQUE (organization_id, event_id, id) lets Phase 4's registration reference (organization_id, event_id,
 * ticket_type_id), so a ticket type from another event is rejected (spec rule 2).
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      "ticket_type",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: queryInterface.sequelize.fn("gen_random_uuid") },
        organization_id: { type: DataTypes.UUID, allowNull: false },
        event_id: { type: DataTypes.UUID, allowNull: false },
        code: { type: DataTypes.STRING(80), allowNull: false },
        name: { type: DataTypes.STRING(255), allowNull: false },
        capacity: { type: DataTypes.INTEGER, allowNull: true },
        display_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        created_by: { type: DataTypes.UUID, allowNull: true },
        updated_by: { type: DataTypes.UUID, allowNull: true },
      },
      { transaction },
    );

    await queryInterface.sequelize.query(
      `ALTER TABLE "ticket_type"
         ADD CONSTRAINT "fk_ticket_type_organization_event" FOREIGN KEY ("organization_id", "event_id")
           REFERENCES "event" ("organization_id", "id") ON UPDATE CASCADE ON DELETE RESTRICT`,
      { transaction },
    );
    await queryInterface.addConstraint("ticket_type", {
      fields: ["organization_id", "event_id", "id"],
      type: "unique",
      name: "uq_ticket_type_organization_event_id",
      transaction,
    });
    await queryInterface.addConstraint("ticket_type", { fields: ["event_id", "code"], type: "unique", name: "uq_ticket_type_event_code", transaction });
    await queryInterface.sequelize.query(
      `ALTER TABLE "ticket_type"
         ADD CONSTRAINT "ck_ticket_type_code_format" CHECK ("code" ~ '^[A-Z0-9_]+$'),
         ADD CONSTRAINT "ck_ticket_type_capacity_positive" CHECK ("capacity" IS NULL OR "capacity" > 0),
         ADD CONSTRAINT "ck_ticket_type_display_order_non_negative" CHECK ("display_order" >= 0)`,
      { transaction },
    );
    await queryInterface.addIndex("ticket_type", ["organization_id", "event_id"], { name: "idx_ticket_type_organization_event", transaction });
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable("ticket_type", { transaction });
  });
};
