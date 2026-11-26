import type { CreationAttributes } from "sequelize";
import { TicketOrder } from "../models/index.js";
import type { TicketOrderRow } from "../models/ticket-order.js";
import { toPlain, toPlainList } from "../utils/sequelize.js";
import { lockOptions, txOptions, type RepoOptions, type WriteOptions } from "./helpers.js";

/** Explicit projection: never `SELECT *`. */
const attributes = [
  "id",
  "organization_id",
  "event_id",
  "reference",
  "source",
  "status",
  "buyer_mobile",
  "buyer_user_id",
  "total_amount",
  "currency",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
] as const satisfies readonly (keyof TicketOrderRow)[];

async function create(values: CreationAttributes<TicketOrder>, options: WriteOptions = {}): Promise<TicketOrderRow> {
  const row = await TicketOrder.create(values, txOptions(options));
  return row.get({ plain: true });
}

/** Event-scoped: an order id alone is never a tenant boundary. */
async function findByEventAndId(organizationId: string, eventId: string, orderId: string, options: RepoOptions = {}): Promise<TicketOrderRow | null> {
  const row = await TicketOrder.findOne({
    where: { organization_id: organizationId, event_id: eventId, id: orderId },
    attributes: [...attributes],
    ...txOptions(options),
    ...lockOptions(options),
  });
  return toPlain<TicketOrderRow>(row);
}

async function referenceExists(reference: string, options: RepoOptions = {}): Promise<boolean> {
  return (await TicketOrder.count({ where: { reference }, ...txOptions(options) })) > 0;
}

/** The event's orders, newest first. `buyerMobile` (E.164) narrows to one buyer. */
async function listByEvent(
  organizationId: string,
  eventId: string,
  filters: { buyerMobile?: string | undefined; limit: number; offset: number },
  options: RepoOptions = {},
): Promise<{ rows: TicketOrderRow[]; count: number }> {
  const { rows, count } = await TicketOrder.findAndCountAll({
    where: { organization_id: organizationId, event_id: eventId, ...(filters.buyerMobile ? { buyer_mobile: filters.buyerMobile } : {}) },
    attributes: [...attributes],
    order: [
      ["created_at", "DESC"],
      ["id", "ASC"],
    ],
    limit: filters.limit,
    offset: filters.offset,
    ...txOptions(options),
  });
  return { rows: toPlainList<TicketOrderRow>(rows), count };
}

export const ticketOrderRepository = { create, findByEventAndId, referenceExists, listByEvent };
