import { col, fn, UniqueConstraintError, type CreationAttributes } from "sequelize";
import { sequelize } from "../db.js";
import { Registration, TicketAdmission } from "../models/index.js";
import type { TicketAdmissionRow } from "../models/ticket-admission.js";
import { toPlain } from "../utils/sequelize.js";
import { lockOptions, txOptions, type RepoOptions, type WriteOptions } from "./helpers.js";

/** Explicit projection: never `SELECT *`. */
const attributes = ["id", "organization_id", "event_id", "registration_id", "admitted_at", "admitted_by", "idempotency_key", "created_at"] as const satisfies readonly (keyof TicketAdmissionRow)[];

async function create(values: CreationAttributes<TicketAdmission>, options: WriteOptions = {}): Promise<TicketAdmissionRow> {
  const row = await TicketAdmission.create(values, txOptions(options));
  return row.get({ plain: true });
}

/**
 * Records an admission unless the ticket or the retry key already has one (a race the registration lock didn't
 * serialize): null then, and the caller reads what is there. A savepoint keeps the caller's transaction usable.
 */
async function createUnlessTaken(values: CreationAttributes<TicketAdmission>, options: WriteOptions): Promise<TicketAdmissionRow | null> {
  try {
    return await sequelize.transaction({ transaction: options.transaction ?? undefined }, async (savepoint) => (await TicketAdmission.create(values, { transaction: savepoint })).get({ plain: true }));
  } catch (error) {
    if (error instanceof UniqueConstraintError) return null;
    throw error;
  }
}

/** The admission a gate request made, by its retry key (tenant-keyed). */
async function findByKey(organizationId: string, idempotencyKey: string, options: RepoOptions = {}): Promise<TicketAdmissionRow | null> {
  const row = await TicketAdmission.findOne({ where: { organization_id: organizationId, idempotency_key: idempotencyKey }, attributes: [...attributes], ...txOptions(options), ...lockOptions(options) });
  return toPlain<TicketAdmissionRow>(row);
}

/** A ticket's admission, if it has been admitted (tenant-keyed). */
async function findByRegistration(organizationId: string, registrationId: string, options: RepoOptions = {}): Promise<TicketAdmissionRow | null> {
  const row = await TicketAdmission.findOne({ where: { organization_id: organizationId, registration_id: registrationId }, attributes: [...attributes], ...txOptions(options), ...lockOptions(options) });
  return toPlain<TicketAdmissionRow>(row);
}

/** Admissions per ticket type of the event (ticket types without any are absent): the attendance count. */
async function countPerTicketType(organizationId: string, eventId: string, options: RepoOptions = {}): Promise<Map<string, number>> {
  const rows = (await TicketAdmission.findAll({
    where: { organization_id: organizationId, event_id: eventId },
    attributes: [[col("registration.ticket_type_id"), "ticket_type_id"], [fn("COUNT", col("TicketAdmission.id")), "admitted"]],
    include: [{ model: Registration, as: "registration", required: true, attributes: [] }],
    group: [col("registration.ticket_type_id")],
    raw: true,
    ...txOptions(options),
  })) as unknown as Array<{ ticket_type_id: string; admitted: string | number }>;
  return new Map(rows.map((row) => [row.ticket_type_id, Number(row.admitted)]));
}

export const ticketAdmissionRepository = { create, createUnlessTaken, findByKey, findByRegistration, countPerTicketType };
