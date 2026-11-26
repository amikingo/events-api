import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Phase 7 step 1: how an event collects its guests.
 * - registration_mode: QUICK (the buyer gives one mobile; tickets may be unnamed) or DETAILED (each ticket holder's
 *   details are collected).
 * - holder_fields: for DETAILED, each of name, mobile, email, affiliation and country is REQUIRED, OPTIONAL or HIDDEN.
 * - purchase_limit_per_mobile: optional most tickets one buyer mobile may hold at the event, across every order.
 * Existing events keep today's form: DETAILED, with name and mobile required and the rest optional.
 */
const HOLDER_FIELD_KEYS = ["name", "mobile", "email", "affiliation", "country"];
const TODAYS_FORM = '{"name":"REQUIRED","mobile":"REQUIRED","email":"OPTIONAL","affiliation":"OPTIONAL","country":"OPTIONAL"}';

export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.addColumn("event", "registration_mode", { type: DataTypes.STRING(20), allowNull: false, defaultValue: "DETAILED" }, { transaction });
    await queryInterface.addColumn(
      "event",
      "holder_fields",
      { type: DataTypes.JSONB, allowNull: false, defaultValue: queryInterface.sequelize.literal(`'${TODAYS_FORM}'::jsonb`) },
      { transaction },
    );
    await queryInterface.addColumn("event", "purchase_limit_per_mobile", { type: DataTypes.INTEGER, allowNull: true }, { transaction });
    const settingIsValid = (key: string) => `("holder_fields" ->> '${key}') IN ('REQUIRED', 'OPTIONAL', 'HIDDEN')`;
    await queryInterface.sequelize.query(
      `ALTER TABLE "event"
         ADD CONSTRAINT "ck_event_registration_mode" CHECK ("registration_mode" IN ('QUICK', 'DETAILED')),
         ADD CONSTRAINT "ck_event_holder_fields" CHECK (
           jsonb_typeof("holder_fields") = 'object'
           AND ("holder_fields" - ARRAY['${HOLDER_FIELD_KEYS.join("', '")}']) = '{}'::jsonb
           AND ${HOLDER_FIELD_KEYS.map(settingIsValid).join(" AND ")}),
         ADD CONSTRAINT "ck_event_purchase_limit_positive" CHECK ("purchase_limit_per_mobile" IS NULL OR "purchase_limit_per_mobile" > 0)`,
      { transaction },
    );
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.removeColumn("event", "purchase_limit_per_mobile", { transaction });
    await queryInterface.removeColumn("event", "holder_fields", { transaction });
    await queryInterface.removeColumn("event", "registration_mode", { transaction });
  });
};
