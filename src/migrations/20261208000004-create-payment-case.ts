import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Phase 8 step 3: payment cases, the money issues staff resolve by hand through the organizer's own Cheche Pay
 * merchant account.
 * - kind: REFUND_REQUIRED (paid after the places were released and none were left), PAID_TWICE (a second attempt also
 *   succeeded), AMOUNT_MISMATCH (Cheche Pay verified another amount: investigate), TICKET_RETURN (a paid ticket
 *   returned from an order, Step 4).
 * - One case per issue: a payment case is identified by its payment attempt (organization + tx_ref), a return by its
 *   ticket (registration_id), so two issues on one order are tracked separately and a repeated webhook or staff
 *   action has one effect.
 * - amount, currency: what is due (or, for a mismatch, what Cheche Pay verified).
 * - Resolution: REFUNDED (the refunded amount, currency and the merchant's refund reference) or CLOSED_WITHOUT_REFUND
 *   (a note saying why), with the staff member and the time. Resolving never changes tickets or orders.
 * - order_payment_id has a plain FK: order_payment has no (organization_id, id) key; the tenant boundary comes from
 *   the composite FK to ticket_order, and the service only links an order's own payment.
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      "payment_case",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: queryInterface.sequelize.fn("gen_random_uuid") },
        organization_id: { type: DataTypes.UUID, allowNull: false },
        event_id: { type: DataTypes.UUID, allowNull: false },
        order_id: { type: DataTypes.UUID, allowNull: false },
        order_payment_id: { type: DataTypes.UUID, allowNull: true },
        registration_id: { type: DataTypes.UUID, allowNull: true },
        kind: { type: DataTypes.STRING(30), allowNull: false },
        tx_ref: { type: DataTypes.STRING(255), allowNull: true },
        amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
        currency: { type: DataTypes.STRING(3), allowNull: false },
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "OPEN" },
        resolution: { type: DataTypes.STRING(30), allowNull: true },
        refunded_amount: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
        refunded_currency: { type: DataTypes.STRING(3), allowNull: true },
        merchant_reference: { type: DataTypes.STRING(255), allowNull: true },
        note: { type: DataTypes.STRING(1000), allowNull: true },
        resolved_by: { type: DataTypes.UUID, allowNull: true },
        resolved_at: { type: DataTypes.DATE, allowNull: true },
        created_by: { type: DataTypes.UUID, allowNull: true },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
      },
      { transaction },
    );
    await queryInterface.sequelize.query(
      `ALTER TABLE "payment_case"
         ADD CONSTRAINT "fk_payment_case_organization_event" FOREIGN KEY ("organization_id", "event_id")
           REFERENCES "event" ("organization_id", "id") ON UPDATE CASCADE ON DELETE RESTRICT,
         ADD CONSTRAINT "fk_payment_case_organization_order" FOREIGN KEY ("organization_id", "order_id")
           REFERENCES "ticket_order" ("organization_id", "id") ON UPDATE CASCADE ON DELETE RESTRICT,
         ADD CONSTRAINT "fk_payment_case_order_payment" FOREIGN KEY ("order_payment_id")
           REFERENCES "order_payment" ("id") ON UPDATE CASCADE ON DELETE RESTRICT,
         ADD CONSTRAINT "fk_payment_case_organization_registration" FOREIGN KEY ("organization_id", "registration_id")
           REFERENCES "registration" ("organization_id", "id") ON UPDATE CASCADE ON DELETE RESTRICT,
         ADD CONSTRAINT "ck_payment_case_kind" CHECK ("kind" IN ('REFUND_REQUIRED', 'PAID_TWICE', 'AMOUNT_MISMATCH', 'TICKET_RETURN')),
         ADD CONSTRAINT "ck_payment_case_subject" CHECK (
           ("kind" = 'TICKET_RETURN' AND "registration_id" IS NOT NULL) OR ("kind" <> 'TICKET_RETURN' AND "registration_id" IS NULL AND "tx_ref" IS NOT NULL)),
         ADD CONSTRAINT "ck_payment_case_amount" CHECK ("amount" >= 0),
         ADD CONSTRAINT "ck_payment_case_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
         ADD CONSTRAINT "ck_payment_case_status" CHECK ("status" IN ('OPEN', 'RESOLVED')),
         ADD CONSTRAINT "ck_payment_case_resolution" CHECK ("resolution" IS NULL OR "resolution" IN ('REFUNDED', 'CLOSED_WITHOUT_REFUND')),
         ADD CONSTRAINT "ck_payment_case_resolved" CHECK (
           ("status" = 'OPEN' AND "resolution" IS NULL AND "resolved_by" IS NULL AND "resolved_at" IS NULL)
           OR ("status" = 'RESOLVED' AND "resolution" IS NOT NULL AND "resolved_by" IS NOT NULL AND "resolved_at" IS NOT NULL)),
         ADD CONSTRAINT "ck_payment_case_refunded" CHECK (
           "resolution" IS DISTINCT FROM 'REFUNDED'
           OR ("refunded_amount" > 0 AND "refunded_currency" ~ '^[A-Z]{3}$' AND "merchant_reference" IS NOT NULL)),
         ADD CONSTRAINT "ck_payment_case_closed_note" CHECK ("resolution" IS DISTINCT FROM 'CLOSED_WITHOUT_REFUND' OR "note" IS NOT NULL);
       CREATE UNIQUE INDEX "uq_payment_case_attempt" ON "payment_case" ("organization_id", "tx_ref") WHERE "kind" <> 'TICKET_RETURN';
       CREATE UNIQUE INDEX "uq_payment_case_return" ON "payment_case" ("registration_id") WHERE "kind" = 'TICKET_RETURN';`,
      { transaction },
    );
    await queryInterface.addIndex("payment_case", ["organization_id", "status", "created_at"], { name: "idx_payment_case_organization_status", transaction });
    await queryInterface.addIndex("payment_case", ["organization_id", "order_id"], { name: "idx_payment_case_organization_order", transaction });
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable("payment_case", { transaction });
  });
};
