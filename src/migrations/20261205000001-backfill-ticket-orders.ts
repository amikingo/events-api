import type { QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Phase 7 step 2 (data only, table ticket_order): one free order for every existing registration, so every ticket
 * belongs to an order. The order takes the registration's id (the next migration links the two by it) and its code
 * as the reference. The buyer is the guest: their phone when it is an Ethiopian mobile in E.164 form, and their
 * linked Cheche account. Nothing is changed on the registration itself here.
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(
      `INSERT INTO "ticket_order"
         ("id", "organization_id", "event_id", "reference", "source", "status", "buyer_mobile", "buyer_user_id",
          "total_amount", "currency", "created_at", "updated_at", "created_by", "updated_by")
       SELECT r."id", r."organization_id", r."event_id", r."code", r."source", 'CONFIRMED',
              CASE WHEN p."phone" ~ '^\\+251[79][0-9]{8}$' THEN p."phone" ELSE NULL END,
              p."user_id", 0, o."default_currency", r."created_at", r."created_at", r."created_by", r."created_by"
         FROM "registration" r
         JOIN "person" p ON p."organization_id" = r."organization_id" AND p."id" = r."person_id"
         JOIN "organization" o ON o."id" = r."organization_id"
        WHERE NOT EXISTS (SELECT 1 FROM "ticket_order" t WHERE t."id" = r."id")`,
      { transaction },
    );
  });
};

/** Removes only the orders this migration made (the ones sharing a registration's id). */
export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(`DELETE FROM "ticket_order" t USING "registration" r WHERE t."id" = r."id"`, { transaction });
  });
};
