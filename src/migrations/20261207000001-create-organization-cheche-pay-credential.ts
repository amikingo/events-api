import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Phase 7 step 3b: one Cheche Pay v2 merchant per organizer, as bookings' nw_organization_cheche_pay_credential.
 * The secret key (sk_test_… / sk_live_…) and the optional webhook secret are AES-256-GCM encrypted by the app
 * (utils/secret-box.ts, CHECHE_PAY_CREDENTIALS_KEY); only the key's mode and last 4 characters are plain.
 * Managed by the platform Super Admin only. is_active false stops new payments; payments already started can
 * still be verified with the switched-off key.
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      "organization_cheche_pay_credential",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: queryInterface.sequelize.fn("gen_random_uuid") },
        organization_id: { type: DataTypes.UUID, allowNull: false },
        key_mode: { type: DataTypes.STRING(10), allowNull: false },
        secret_key_encrypted: { type: DataTypes.TEXT, allowNull: false },
        secret_key_last4: { type: DataTypes.STRING(4), allowNull: false },
        webhook_secret_encrypted: { type: DataTypes.TEXT, allowNull: true },
        is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        created_by: { type: DataTypes.UUID, allowNull: true },
        updated_by: { type: DataTypes.UUID, allowNull: true },
      },
      { transaction },
    );
    await queryInterface.addConstraint("organization_cheche_pay_credential", {
      fields: ["organization_id"],
      type: "foreign key",
      name: "fk_organization_cheche_pay_credential_organization_id",
      references: { table: "organization", field: "id" },
      onUpdate: "CASCADE",
      onDelete: "RESTRICT",
      transaction,
    });
    await queryInterface.addConstraint("organization_cheche_pay_credential", {
      fields: ["organization_id"],
      type: "unique",
      name: "uq_organization_cheche_pay_credential_organization_id",
      transaction,
    });
    await queryInterface.sequelize.query(
      `ALTER TABLE "organization_cheche_pay_credential"
         ADD CONSTRAINT "ck_organization_cheche_pay_credential_key_mode" CHECK ("key_mode" IN ('test', 'live')),
         ADD CONSTRAINT "ck_organization_cheche_pay_credential_last4" CHECK (char_length("secret_key_last4") = 4)`,
      { transaction },
    );
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable("organization_cheche_pay_credential", { transaction });
  });
};
