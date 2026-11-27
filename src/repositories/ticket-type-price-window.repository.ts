import type { Transaction } from "sequelize";
import { TicketTypePriceWindow } from "../models/index.js";
import type { TicketTypePriceWindowRow } from "../models/ticket-type-price-window.js";
import { toPlainList } from "../utils/sequelize.js";
import { txOptions, type RepoOptions } from "./helpers.js";

/** Explicit projection: never `SELECT *`. Every read and write is keyed by organization_id + event_id. */
const attributes = ["id", "organization_id", "event_id", "ticket_type_id", "starts_at", "ends_at", "price", "created_at", "created_by"] as const satisfies readonly (keyof TicketTypePriceWindowRow)[];

export type PriceWindowValues = { starts_at: Date; ends_at: Date | null; price: string };

async function listByTicketTypes(organizationId: string, eventId: string, ticketTypeIds: readonly string[], options: RepoOptions = {}): Promise<TicketTypePriceWindowRow[]> {
  if (ticketTypeIds.length === 0) return [];
  const rows = await TicketTypePriceWindow.findAll({
    where: { organization_id: organizationId, event_id: eventId, ticket_type_id: [...ticketTypeIds] },
    attributes: [...attributes],
    order: [["starts_at", "ASC"]],
    ...txOptions(options),
  });
  return toPlainList<TicketTypePriceWindowRow>(rows);
}

async function listByEvent(organizationId: string, eventId: string, options: RepoOptions = {}): Promise<TicketTypePriceWindowRow[]> {
  const rows = await TicketTypePriceWindow.findAll({
    where: { organization_id: organizationId, event_id: eventId },
    attributes: [...attributes],
    order: [["starts_at", "ASC"]],
    ...txOptions(options),
  });
  return toPlainList<TicketTypePriceWindowRow>(rows);
}

/** Replaces a ticket type's whole schedule in the caller's transaction ([] clears it). */
async function replaceForTicketType(
  organizationId: string,
  eventId: string,
  ticketTypeId: string,
  windows: readonly PriceWindowValues[],
  actorId: string | null,
  options: { transaction: Transaction },
): Promise<TicketTypePriceWindowRow[]> {
  await TicketTypePriceWindow.destroy({ where: { organization_id: organizationId, event_id: eventId, ticket_type_id: ticketTypeId }, transaction: options.transaction });
  if (windows.length === 0) return [];
  const rows = await TicketTypePriceWindow.bulkCreate(
    windows.map((window) => ({ organization_id: organizationId, event_id: eventId, ticket_type_id: ticketTypeId, ...window, created_by: actorId })),
    { transaction: options.transaction, returning: true },
  );
  return rows.map((row) => row.get({ plain: true })).sort((a, b) => a.starts_at.getTime() - b.starts_at.getTime());
}

export const ticketTypePriceWindowRepository = { listByTicketTypes, listByEvent, replaceForTicketType };
