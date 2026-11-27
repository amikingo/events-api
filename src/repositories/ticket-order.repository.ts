import { Op, type CreationAttributes } from "sequelize";
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
  "hold_expires_at",
  "access_token_hash",
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

/** Phase 7 step 3: an order by id within its organization (payments know the order, not the event). */
async function findByOrganizationAndId(organizationId: string, orderId: string, options: RepoOptions = {}): Promise<TicketOrderRow | null> {
  const row = await TicketOrder.findOne({ where: { organization_id: organizationId, id: orderId }, attributes: [...attributes], ...txOptions(options), ...lockOptions(options) });
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

/** Phase 7 step 3: an order by its public reference, in any organization (the buyer's order page). */
async function findByReference(reference: string, options: RepoOptions = {}): Promise<TicketOrderRow | null> {
  const row = await TicketOrder.findOne({ where: { reference }, attributes: [...attributes], ...txOptions(options), ...lockOptions(options) });
  return toPlain<TicketOrderRow>(row);
}

export type OrderUpdateValues = Partial<Pick<TicketOrderRow, "status" | "hold_expires_at" | "access_token_hash" | "updated_by">>;

async function updateById(organizationId: string, orderId: string, values: OrderUpdateValues, options: WriteOptions = {}): Promise<void> {
  await TicketOrder.update(values, { where: { organization_id: organizationId, id: orderId }, ...txOptions(options) });
}

/** Phase 7 step 3: pending orders of one event whose holds have run out (released under the event lock). */
async function listExpiredPendingByEvent(organizationId: string, eventId: string, now: Date, options: RepoOptions = {}): Promise<TicketOrderRow[]> {
  const rows = await TicketOrder.findAll({
    where: { organization_id: organizationId, event_id: eventId, status: "PENDING_PAYMENT", hold_expires_at: { [Op.lte]: now } },
    attributes: [...attributes],
    ...txOptions(options),
  });
  return toPlainList<TicketOrderRow>(rows);
}

/** Phase 9: every order of the event still waiting for payment, whatever its hold (cancelling the event releases them all). */
async function listPendingByEvent(organizationId: string, eventId: string, options: RepoOptions = {}): Promise<TicketOrderRow[]> {
  const rows = await TicketOrder.findAll({ where: { organization_id: organizationId, event_id: eventId, status: "PENDING_PAYMENT" }, attributes: [...attributes], ...txOptions(options) });
  return toPlainList<TicketOrderRow>(rows);
}

/** Phase 9: several orders of one event by id (the buyers an event change is told about). */
async function listByEventAndIds(organizationId: string, eventId: string, orderIds: readonly string[], options: RepoOptions = {}): Promise<TicketOrderRow[]> {
  if (orderIds.length === 0) return [];
  const rows = await TicketOrder.findAll({ where: { organization_id: organizationId, event_id: eventId, id: [...orderIds] }, attributes: [...attributes], ...txOptions(options) });
  return toPlainList<TicketOrderRow>(rows);
}

/** Phase 7 step 3: pending orders past their hold, oldest first, across organizations (the payment worker). */
async function listExpiredPending(now: Date, limit: number, options: RepoOptions = {}): Promise<TicketOrderRow[]> {
  const rows = await TicketOrder.findAll({
    where: { status: "PENDING_PAYMENT", hold_expires_at: { [Op.lte]: now } },
    attributes: [...attributes],
    order: [
      ["hold_expires_at", "ASC"],
      ["id", "ASC"],
    ],
    limit,
    ...txOptions(options),
  });
  return toPlainList<TicketOrderRow>(rows);
}

export const ticketOrderRepository = { create, findByEventAndId, findByReference, findByOrganizationAndId, referenceExists, listByEvent, updateById, listExpiredPendingByEvent, listExpiredPending, listPendingByEvent, listByEventAndIds };
