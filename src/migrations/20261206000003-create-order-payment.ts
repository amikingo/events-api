import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Phase 7 step 3: the Cheche Pay payment of one paid order, shaped like bookings' payment item.
 * - id: sent to Cheche Pay as `transaction_id` and echoed back in its callback; reused on every retry.
 * - payment_option_id: the option the buyer chose (Telebirr…), checked against the organizer's options.
 * - cheche_pay_service: the organizer's service code at checkout (the receiving merchant).
 * - amount, currency: what the order expects (Cheche Pay works in ETB).
 * - status: INITIATED (created, or sent to Cheche Pay), PAID (a matching "Completed" callback), MISMATCH (a
 *   "Completed" callback for another amount: kept for review, nothing issued).
 * - vendor_ref: Cheche Pay's reference from the paying callback; unique once set, so a payment counts once.
 * - provider_order_id: Cheche Pay's own order id from createOrder, when it gives one (callback fallback, as bookings
 *   does with merch_order_id).
 * - request_object, response_object, last_notification: what was sent, what came back, and the latest callback, for
 *   staff review.
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      "order_payment",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: queryInterface.sequelize.fn("gen_random_uuid") },
        organization_id: { type: DataTypes.UUID, allowNull: false },
        order_id: { type: DataTypes.UUID, allowNull: false },
        payment_option_id: { type: DataTypes.STRING(100), allowNull: false },
        cheche_pay_service: { type: DataTypes.STRING(80), allowNull: false },
        amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
        currency: { type: DataTypes.STRING(3), allowNull: false },
        status: { type: DataTypes.STRING(20), allowNull: false },
        checkout_url: { type: DataTypes.STRING(2000), allowNull: true },
        vendor_ref: { type: DataTypes.STRING(255), allowNull: true },
        provider_order_id: { type: DataTypes.STRING(255), allowNull: true },
        notify_time: { type: DataTypes.DATE, allowNull: true },
        request_object: { type: DataTypes.JSONB, allowNull: true },
        response_object: { type: DataTypes.JSONB, allowNull: true },
        last_notification: { type: DataTypes.JSONB, allowNull: true },
        last_error: { type: DataTypes.STRING(500), allowNull: true },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
      },
      { transaction },
    );
    await queryInterface.sequelize.query(
      `ALTER TABLE "order_payment"
         ADD CONSTRAINT "fk_order_payment_organization_order" FOREIGN KEY ("organization_id", "order_id")
           REFERENCES "ticket_order" ("organization_id", "id") ON UPDATE CASCADE ON DELETE RESTRICT,
         ADD CONSTRAINT "uq_order_payment_order_id" UNIQUE ("order_id"),
         ADD CONSTRAINT "ck_order_payment_status" CHECK ("status" IN ('INITIATED', 'PAID', 'MISMATCH')),
         ADD CONSTRAINT "ck_order_payment_amount_positive" CHECK ("amount" > 0),
         ADD CONSTRAINT "ck_order_payment_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
         ADD CONSTRAINT "ck_order_payment_paid_has_vendor_ref" CHECK ("status" <> 'PAID' OR ("vendor_ref" IS NOT NULL AND "notify_time" IS NOT NULL))`,
      { transaction },
    );
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX "uq_order_payment_vendor_ref" ON "order_payment" ("vendor_ref") WHERE "vendor_ref" IS NOT NULL;
       CREATE INDEX "idx_order_payment_provider_order_id" ON "order_payment" ("provider_order_id") WHERE "provider_order_id" IS NOT NULL;`,
      { transaction },
    );
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable("order_payment", { transaction });
  });
};
