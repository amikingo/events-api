import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

/**
 * Ticket designs: how an event's tickets look, chosen by the organizer and shown to buyers. At most one row per
 * event; no row means the booking site's standard designs.
 * - design: the booking site's name for a layout (it owns the list, so a new layout needs no migration).
 * - color: a named colour, or the organizer's own as #rrggbb; NULL keeps the design's own colours.
 * - qr_x, qr_y, qr_size: where the QR panel goes on the organizer's own artwork (design 'custom'), as fractions.
 * - Up to three pictures, each a `file` row of the same organization: a logo, a picture and the custom artwork.
 *   `file` gains those three purposes; like a cover, each names its event.
 * down() restores the old purpose check, so it fails (and rolls back) while ticket design files exist.
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      "event_ticket_design",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: queryInterface.sequelize.fn("gen_random_uuid") },
        organization_id: { type: DataTypes.UUID, allowNull: false },
        event_id: { type: DataTypes.UUID, allowNull: false },
        design: { type: DataTypes.STRING(30), allowNull: false },
        color: { type: DataTypes.STRING(20), allowNull: true },
        note: { type: DataTypes.STRING(60), allowNull: true },
        show_price: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        show_venue: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        show_guest: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        qr_x: { type: DataTypes.DOUBLE, allowNull: false, defaultValue: 0.5 },
        qr_y: { type: DataTypes.DOUBLE, allowNull: false, defaultValue: 1 },
        qr_size: { type: DataTypes.STRING(1), allowNull: false, defaultValue: "m" },
        logo_file_id: { type: DataTypes.UUID, allowNull: true },
        picture_file_id: { type: DataTypes.UUID, allowNull: true },
        artwork_file_id: { type: DataTypes.UUID, allowNull: true },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: queryInterface.sequelize.fn("now") },
        created_by: { type: DataTypes.UUID, allowNull: true },
        updated_by: { type: DataTypes.UUID, allowNull: true },
      },
      { transaction },
    );
    await queryInterface.sequelize.query(
      `ALTER TABLE "event_ticket_design"
         ADD CONSTRAINT "uq_event_ticket_design_organization_id_id" UNIQUE ("organization_id", "id"),
         ADD CONSTRAINT "uq_event_ticket_design_organization_event" UNIQUE ("organization_id", "event_id"),
         ADD CONSTRAINT "fk_event_ticket_design_event" FOREIGN KEY ("organization_id", "event_id")
           REFERENCES "event" ("organization_id", "id") ON UPDATE CASCADE ON DELETE CASCADE,
         ADD CONSTRAINT "fk_event_ticket_design_logo_file" FOREIGN KEY ("organization_id", "logo_file_id")
           REFERENCES "file" ("organization_id", "id") ON UPDATE CASCADE ON DELETE RESTRICT,
         ADD CONSTRAINT "fk_event_ticket_design_picture_file" FOREIGN KEY ("organization_id", "picture_file_id")
           REFERENCES "file" ("organization_id", "id") ON UPDATE CASCADE ON DELETE RESTRICT,
         ADD CONSTRAINT "fk_event_ticket_design_artwork_file" FOREIGN KEY ("organization_id", "artwork_file_id")
           REFERENCES "file" ("organization_id", "id") ON UPDATE CASCADE ON DELETE RESTRICT,
         ADD CONSTRAINT "ck_event_ticket_design_design" CHECK ("design" ~ '^[a-z][a-z-]{0,29}$'),
         ADD CONSTRAINT "ck_event_ticket_design_color"
           CHECK ("color" IS NULL OR "color" ~ '^([a-z]{3,10}|#[0-9a-f]{6})$'),
         ADD CONSTRAINT "ck_event_ticket_design_qr_place" CHECK ("qr_x" BETWEEN 0 AND 1 AND "qr_y" BETWEEN 0 AND 1),
         ADD CONSTRAINT "ck_event_ticket_design_qr_size" CHECK ("qr_size" IN ('s', 'm', 'l')),
         ADD CONSTRAINT "ck_event_ticket_design_custom_artwork"
           CHECK ("design" <> 'custom' OR "artwork_file_id" IS NOT NULL)`,
      { transaction },
    );
    await queryInterface.sequelize.query(
      `ALTER TABLE "file"
         DROP CONSTRAINT "ck_file_purpose",
         ADD CONSTRAINT "ck_file_purpose"
           CHECK ("purpose" IN ('EVENT_COVER', 'EVENT_TICKET_LOGO', 'EVENT_TICKET_PICTURE', 'EVENT_TICKET_ARTWORK')),
         ADD CONSTRAINT "ck_file_event_ticket_entity"
           CHECK ("purpose" NOT IN ('EVENT_TICKET_LOGO', 'EVENT_TICKET_PICTURE', 'EVENT_TICKET_ARTWORK')
             OR ("entity_type" = 'EVENT' AND "entity_id" IS NOT NULL))`,
      { transaction },
    );
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable("event_ticket_design", { transaction });
    await queryInterface.sequelize.query(
      `ALTER TABLE "file"
         DROP CONSTRAINT "ck_file_event_ticket_entity",
         DROP CONSTRAINT "ck_file_purpose",
         ADD CONSTRAINT "ck_file_purpose" CHECK ("purpose" IN ('EVENT_COVER'))`,
      { transaction },
    );
  });
};
