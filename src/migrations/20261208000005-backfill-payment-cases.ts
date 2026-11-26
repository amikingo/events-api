import type { QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Phase 8 step 3: opens a case for every money issue already in the database, so staff see them with the new ones:
 * - orders already REFUND_REQUIRED (keyed by the payment's paid_tx_ref; the order total is due);
 * - payments already MISMATCH (keyed by their tx_ref; the verified amount when it was recorded, else the expected one);
 * - PAID_TWICE notes (the second tx_ref, as written in last_error by paymentService.settle).
 * Safe to re-run: a case that exists is left alone. Data only; down leaves the cases (000004's down drops the table).
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(
      `INSERT INTO "payment_case" ("organization_id", "event_id", "order_id", "order_payment_id", "kind", "tx_ref", "amount", "currency")
       SELECT o."organization_id", o."event_id", o."id", p."id", 'REFUND_REQUIRED', p."paid_tx_ref", p."amount", p."currency"
         FROM "ticket_order" o JOIN "order_payment" p ON p."order_id" = o."id"
        WHERE o."status" = 'REFUND_REQUIRED' AND p."paid_tx_ref" IS NOT NULL
       ON CONFLICT DO NOTHING`,
      { transaction },
    );
    await queryInterface.sequelize.query(
      `INSERT INTO "payment_case" ("organization_id", "event_id", "order_id", "order_payment_id", "kind", "tx_ref", "amount", "currency")
       SELECT o."organization_id", o."event_id", o."id", p."id", 'AMOUNT_MISMATCH', p."tx_ref",
              CASE WHEN (p."last_verification"->>'amount') ~ '^[0-9]{1,10}([.][0-9]{1,2})?$' THEN (p."last_verification"->>'amount')::numeric ELSE p."amount" END,
              p."currency"
         FROM "ticket_order" o JOIN "order_payment" p ON p."order_id" = o."id"
        WHERE p."status" = 'MISMATCH' AND p."tx_ref" IS NOT NULL
       ON CONFLICT DO NOTHING`,
      { transaction },
    );
    await queryInterface.sequelize.query(
      `INSERT INTO "payment_case" ("organization_id", "event_id", "order_id", "order_payment_id", "kind", "tx_ref", "amount", "currency")
       SELECT o."organization_id", o."event_id", o."id", p."id", 'PAID_TWICE', substring(p."last_error" from 'attempt \\(([^)]+)\\)'), p."amount", p."currency"
         FROM "ticket_order" o JOIN "order_payment" p ON p."order_id" = o."id"
        WHERE p."last_error" LIKE 'A second Cheche Pay attempt (%) also succeeded%'
       ON CONFLICT DO NOTHING`,
      { transaction },
    );
  });
};

// The cases stay: they may have been resolved since. 20261208000004's down drops the table.
export const down: MigrationFn<QueryInterface> = () => Promise.resolve();
