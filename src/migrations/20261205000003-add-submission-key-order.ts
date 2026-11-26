import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Phase 7 step 2: a retry key may now point at an order (checkout) instead of a registration (the single-ticket
 * endpoints). Exactly one of the two is set. Two new scopes: PUBLIC_CHECKOUT and STAFF_CHECKOUT.
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.addColumn("submission_key", "order_id", { type: DataTypes.UUID, allowNull: true }, { transaction });
    await queryInterface.changeColumn("submission_key", "registration_id", { type: DataTypes.UUID, allowNull: true }, { transaction });
    await queryInterface.sequelize.query(
      `ALTER TABLE "submission_key"
         DROP CONSTRAINT "ck_submission_key_scope",
         ADD CONSTRAINT "ck_submission_key_scope" CHECK ("scope" IN ('PUBLIC_REGISTRATION', 'STAFF_REGISTRATION', 'PUBLIC_CHECKOUT', 'STAFF_CHECKOUT')),
         ADD CONSTRAINT "fk_submission_key_organization_order" FOREIGN KEY ("organization_id", "order_id")
           REFERENCES "ticket_order" ("organization_id", "id") ON UPDATE CASCADE ON DELETE RESTRICT,
         ADD CONSTRAINT "ck_submission_key_one_target" CHECK (("registration_id" IS NULL) <> ("order_id" IS NULL))`,
      { transaction },
    );
    await queryInterface.addIndex("submission_key", ["organization_id", "order_id"], { name: "idx_submission_key_order", transaction });
  });
};

/** Only safe while no checkout keys exist. */
export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(
      `ALTER TABLE "submission_key"
         DROP CONSTRAINT "ck_submission_key_one_target",
         DROP CONSTRAINT "ck_submission_key_scope",
         ADD CONSTRAINT "ck_submission_key_scope" CHECK ("scope" IN ('PUBLIC_REGISTRATION', 'STAFF_REGISTRATION'))`,
      { transaction },
    );
    await queryInterface.removeColumn("submission_key", "order_id", { transaction });
    await queryInterface.changeColumn("submission_key", "registration_id", { type: DataTypes.UUID, allowNull: false }, { transaction });
  });
};
