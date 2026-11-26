import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Phase 7 step 2: ticket_order, one buyer's checkout at one event. Each ticket (a registration row) belongs to one
 * order; the order keeps what was true at checkout: the buyer's delivery mobile, the total and the currency.
 * - reference: the public order reference, unique (10 characters from the registration-code alphabet; orders made
 *   from existing registrations reuse that registration's 8-character code).
 * - buyer_mobile: E.164, the normalized delivery mobile; the purchase limit counts tickets per buyer mobile.
 * - buyer_user_id: the Cheche account of a signed-in buyer (a verified identity), for My Tickets. Logical reference.
 * - status: CONFIRMED for now (paid checkout adds more in step 3).
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      "ticket_order",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: queryInterface.sequelize.fn("gen_random_uuid") },
        organization_id: { type: DataTypes.UUID, allowNull: false },
        event_id: { type: DataTypes.UUID, allowNull: false },
        reference: { type: DataTypes.STRING(10), allowNull: false },
        source: { type: DataTypes.STRING(20), allowNull: false },
        status: { type: DataTypes.STRING(20), allowNull: false },
        buyer_mobile: { type: DataTypes.STRING(16), allowNull: true },
        buyer_user_id: { type: DataTypes.UUID, allowNull: true },
        total_amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
        currency: { type: DataTypes.STRING(3), allowNull: false },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        created_by: { type: DataTypes.UUID, allowNull: true },
        updated_by: { type: DataTypes.UUID, allowNull: true },
      },
      { transaction },
    );
    await queryInterface.sequelize.query(
      `ALTER TABLE "ticket_order"
         ADD CONSTRAINT "fk_ticket_order_organization_event" FOREIGN KEY ("organization_id", "event_id")
           REFERENCES "event" ("organization_id", "id") ON UPDATE CASCADE ON DELETE RESTRICT,
         ADD CONSTRAINT "uq_ticket_order_organization_id_id" UNIQUE ("organization_id", "id"),
         ADD CONSTRAINT "uq_ticket_order_reference" UNIQUE ("reference"),
         ADD CONSTRAINT "ck_ticket_order_reference_format" CHECK ("reference" ~ '^[A-HJKMNP-Z2-9]{8,10}$'),
         ADD CONSTRAINT "ck_ticket_order_source" CHECK ("source" IN ('STAFF', 'PUBLIC')),
         ADD CONSTRAINT "ck_ticket_order_status" CHECK ("status" IN ('CONFIRMED')),
         ADD CONSTRAINT "ck_ticket_order_buyer_mobile_format" CHECK ("buyer_mobile" IS NULL OR "buyer_mobile" ~ '^\\+251[79][0-9]{8}$'),
         ADD CONSTRAINT "ck_ticket_order_total_non_negative" CHECK ("total_amount" >= 0),
         ADD CONSTRAINT "ck_ticket_order_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$')`,
      { transaction },
    );
    await queryInterface.addIndex("ticket_order", ["organization_id", "event_id", "buyer_mobile"], { name: "idx_ticket_order_event_buyer_mobile", transaction });
    await queryInterface.addIndex("ticket_order", ["organization_id", "event_id", "created_at"], { name: "idx_ticket_order_event_created", transaction });
    await queryInterface.addIndex("ticket_order", ["buyer_user_id"], { name: "idx_ticket_order_buyer_user_id", transaction });
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable("ticket_order", { transaction });
  });
};
