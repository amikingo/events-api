import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Organization defaults (spec §1): country, timezone and default_currency, editable per organization. Existing
 * organizations had no such settings, so they start at the Ethiopian pilot's values (ET, Africa/Addis_Ababa, ETB).
 * A new event copies the organization's timezone; later changes here never touch existing events.
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.addColumn("organization", "country", { type: DataTypes.STRING(2), allowNull: false, defaultValue: "ET" }, { transaction });
    await queryInterface.addColumn(
      "organization",
      "timezone",
      { type: DataTypes.STRING(64), allowNull: false, defaultValue: "Africa/Addis_Ababa" },
      { transaction },
    );
    await queryInterface.addColumn(
      "organization",
      "default_currency",
      { type: DataTypes.STRING(3), allowNull: false, defaultValue: "ETB" },
      { transaction },
    );
    await queryInterface.sequelize.query(
      `ALTER TABLE "organization"
         ADD CONSTRAINT "ck_organization_country_format" CHECK ("country" ~ '^[A-Z]{2}$'),
         ADD CONSTRAINT "ck_organization_default_currency_format" CHECK ("default_currency" ~ '^[A-Z]{3}$'),
         ADD CONSTRAINT "ck_organization_timezone_present" CHECK (length("timezone") > 0)`,
      { transaction },
    );
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    // Dropping a column drops its CHECK constraint with it.
    await queryInterface.removeColumn("organization", "default_currency", { transaction });
    await queryInterface.removeColumn("organization", "timezone", { transaction });
    await queryInterface.removeColumn("organization", "country", { transaction });
  });
};
