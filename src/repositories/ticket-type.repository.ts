import { Op, type CreationAttributes } from "sequelize";
import { TicketType } from "../models/index.js";
import type { TicketTypeRow } from "../models/ticket-type.js";
import { toPlain, toPlainList } from "../utils/sequelize.js";
import { lockOptions, txOptions, type RepoOptions, type WriteOptions } from "./helpers.js";

/** Explicit projection: never `SELECT *`. */
const attributes = [
  "id",
  "organization_id",
  "event_id",
  "code",
  "name",
  "capacity",
  "price",
  "currency",
  "audience",
  "display_order",
  "is_active",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
] as const satisfies readonly (keyof TicketTypeRow)[];

export type TicketTypeUpdateValues = Partial<Pick<TicketTypeRow, "code" | "name" | "capacity" | "display_order" | "is_active" | "updated_by">>;

async function create(values: CreationAttributes<TicketType>, options: WriteOptions = {}): Promise<TicketTypeRow> {
  const row = await TicketType.create(values, txOptions(options));
  return row.get({ plain: true });
}

// Every read/write is keyed by organization_id + event_id + id.
async function findByEventAndId(
  organizationId: string,
  eventId: string,
  ticketTypeId: string,
  options: RepoOptions = {},
): Promise<TicketTypeRow | null> {
  const row = await TicketType.findOne({
    where: { organization_id: organizationId, event_id: eventId, id: ticketTypeId },
    attributes: [...attributes],
    ...txOptions(options),
    ...lockOptions(options),
  });
  return toPlain<TicketTypeRow>(row);
}

async function findByEventAndCode(organizationId: string, eventId: string, code: string, options: RepoOptions = {}): Promise<TicketTypeRow | null> {
  const row = await TicketType.findOne({
    where: { organization_id: organizationId, event_id: eventId, code },
    attributes: [...attributes],
    ...txOptions(options),
  });
  return toPlain<TicketTypeRow>(row);
}

async function listByEvent(organizationId: string, eventId: string, options: RepoOptions = {}): Promise<TicketTypeRow[]> {
  const rows = await TicketType.findAll({
    where: { organization_id: organizationId, event_id: eventId },
    attributes: [...attributes],
    order: [
      ["display_order", "ASC"],
      ["code", "ASC"],
    ],
    ...txOptions(options),
  });
  return toPlainList<TicketTypeRow>(rows);
}

async function listActiveByEvent(organizationId: string, eventId: string, options: RepoOptions = {}): Promise<TicketTypeRow[]> {
  const rows = await TicketType.findAll({
    where: { organization_id: organizationId, event_id: eventId, is_active: true },
    attributes: [...attributes],
    order: [
      ["display_order", "ASC"],
      ["code", "ASC"],
    ],
    ...txOptions(options),
  });
  return toPlainList<TicketTypeRow>(rows);
}

/**
 * The public catalog: the active PUBLIC ticket types of several events, in one query. Each event is named with its
 * organization, so the tenant boundary holds although the catalog spans organizations.
 */
async function listActivePublicByEvents(events: readonly { organization_id: string; id: string }[], options: RepoOptions = {}): Promise<TicketTypeRow[]> {
  if (events.length === 0) return [];
  const rows = await TicketType.findAll({
    where: { [Op.or]: events.map((event) => ({ organization_id: event.organization_id, event_id: event.id })), is_active: true, audience: "PUBLIC" },
    attributes: [...attributes],
    order: [
      ["display_order", "ASC"],
      ["code", "ASC"],
    ],
    ...txOptions(options),
  });
  return toPlainList<TicketTypeRow>(rows);
}

async function countActiveByEvent(organizationId: string, eventId: string, options: RepoOptions = {}): Promise<number> {
  return TicketType.count({ where: { organization_id: organizationId, event_id: eventId, is_active: true }, ...txOptions(options) });
}

/** The largest separate ticket limit of the event (any status), or null when none has one. */
async function maxCapacityByEvent(organizationId: string, eventId: string, options: RepoOptions = {}): Promise<number | null> {
  const value: unknown = await TicketType.max("capacity", { where: { organization_id: organizationId, event_id: eventId }, ...txOptions(options) });
  return typeof value === "number" ? value : null;
}

async function maxDisplayOrderByEvent(organizationId: string, eventId: string, options: RepoOptions = {}): Promise<number | null> {
  const value: unknown = await TicketType.max("display_order", {
    where: { organization_id: organizationId, event_id: eventId },
    ...txOptions(options),
  });
  return typeof value === "number" ? value : null;
}

/** Tenant-scoped update + tenant-scoped read-back inside the same transaction. */
async function updateByEventAndId(
  organizationId: string,
  eventId: string,
  ticketTypeId: string,
  values: TicketTypeUpdateValues,
  options: WriteOptions = {},
): Promise<TicketTypeRow | null> {
  await TicketType.update(values, { where: { organization_id: organizationId, event_id: eventId, id: ticketTypeId }, ...txOptions(options) });
  return findByEventAndId(organizationId, eventId, ticketTypeId, options);
}

export const ticketTypeRepository = {
  create,
  findByEventAndId,
  findByEventAndCode,
  listByEvent,
  listActiveByEvent,
  listActivePublicByEvents,
  countActiveByEvent,
  maxCapacityByEvent,
  maxDisplayOrderByEvent,
  updateByEventAndId,
};
