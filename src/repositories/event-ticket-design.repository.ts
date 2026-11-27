import type { CreationAttributes } from "sequelize";
import { EventTicketDesign } from "../models/index.js";
import type { EventTicketDesignRow } from "../models/event-ticket-design.js";
import { toPlain } from "../utils/sequelize.js";
import { lockOptions, txOptions, type RepoOptions, type WriteOptions } from "./helpers.js";

/** Explicit projection: never `SELECT *`. */
const attributes = [
  "id",
  "organization_id",
  "event_id",
  "design",
  "color",
  "note",
  "show_price",
  "show_venue",
  "show_guest",
  "qr_x",
  "qr_y",
  "qr_size",
  "logo_file_id",
  "picture_file_id",
  "artwork_file_id",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
] as const satisfies readonly (keyof EventTicketDesignRow)[];

export type EventTicketDesignUpdateValues = Partial<
  Pick<
    EventTicketDesignRow,
    | "design"
    | "color"
    | "note"
    | "show_price"
    | "show_venue"
    | "show_guest"
    | "qr_x"
    | "qr_y"
    | "qr_size"
    | "logo_file_id"
    | "picture_file_id"
    | "artwork_file_id"
    | "updated_by"
  >
>;

// An event's design is keyed by organization_id + event_id. An id alone is never a tenant boundary.
async function findByEvent(organizationId: string, eventId: string, options: RepoOptions = {}): Promise<EventTicketDesignRow | null> {
  const row = await EventTicketDesign.findOne({
    where: { organization_id: organizationId, event_id: eventId },
    attributes: [...attributes],
    ...txOptions(options),
    ...lockOptions(options),
  });
  return toPlain<EventTicketDesignRow>(row);
}

async function create(values: CreationAttributes<EventTicketDesign>, options: WriteOptions = {}): Promise<EventTicketDesignRow> {
  const row = await EventTicketDesign.create(values, txOptions(options));
  return row.get({ plain: true });
}

async function updateByEvent(
  organizationId: string,
  eventId: string,
  values: EventTicketDesignUpdateValues,
  options: WriteOptions = {},
): Promise<EventTicketDesignRow | null> {
  await EventTicketDesign.update(values, { where: { organization_id: organizationId, event_id: eventId }, ...txOptions(options) });
  return findByEvent(organizationId, eventId, options);
}

/** Removes the design; true when there was one. Its files stay for a later clean-up. */
async function deleteByEvent(organizationId: string, eventId: string, options: WriteOptions = {}): Promise<boolean> {
  const count = await EventTicketDesign.destroy({ where: { organization_id: organizationId, event_id: eventId }, ...txOptions(options) });
  return count > 0;
}

export const eventTicketDesignRepository = { findByEvent, create, updateByEvent, deleteByEvent };
