import { Op, QueryTypes, type CreationAttributes } from "sequelize";
import { sequelize } from "../db.js";
import { MessageOutbox } from "../models/index.js";
import type { MessageOutboxRow, MessageStatus } from "../models/message-outbox.js";
import { txOptions, type RepoOptions, type WriteOptions } from "./helpers.js";

/** Queues a message. Always called inside the transaction of the change it reports (spec rule 5). */
async function create(values: CreationAttributes<MessageOutbox>, options: WriteOptions = {}): Promise<MessageOutboxRow> {
  const row = await MessageOutbox.create(values, txOptions(options));
  return row.get({ plain: true });
}

/**
 * Claims up to `limit` due PENDING messages in one statement: each gets attempts + 1 and a lease (next_attempt_at
 * pushed out), so no other worker claims it meanwhile. SKIP LOCKED lets several API instances claim in parallel
 * without waiting on each other or claiming the same row.
 */
async function claimDue(now: Date, limit: number, leaseMs: number): Promise<MessageOutboxRow[]> {
  const rows = await sequelize.query<MessageOutboxRow>(
    `UPDATE "message_outbox"
        SET "attempts" = "attempts" + 1, "next_attempt_at" = :leaseUntil, "updated_at" = :now
      WHERE "id" IN (
        SELECT "id" FROM "message_outbox"
         WHERE "status" = 'PENDING' AND "next_attempt_at" <= :now
         ORDER BY "next_attempt_at", "id"
         LIMIT :limit
         FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    { replacements: { now, leaseUntil: new Date(now.getTime() + leaseMs), limit }, type: QueryTypes.SELECT },
  );
  return rows;
}

async function markSent(id: string, sentAt: Date, providerMessageId: string | null): Promise<void> {
  await MessageOutbox.update(
    { status: "SENT", sent_at: sentAt, provider_message_id: providerMessageId, last_error: null },
    { where: { id, status: "PENDING" } },
  );
}

/** Back to PENDING after a failed attempt, due again at `nextAttemptAt`. */
async function markForRetry(id: string, nextAttemptAt: Date, error: string): Promise<void> {
  await MessageOutbox.update({ next_attempt_at: nextAttemptAt, last_error: error.slice(0, 500) }, { where: { id, status: "PENDING" } });
}

async function markFinal(id: string, status: Extract<MessageStatus, "FAILED" | "SKIPPED">, reason: string): Promise<void> {
  await MessageOutbox.update({ status, last_error: reason.slice(0, 500) }, { where: { id, status: "PENDING" } });
}

async function countSentSince(since: Date): Promise<number> {
  return MessageOutbox.count({ where: { status: "SENT", sent_at: { [Op.gte]: since } } });
}

async function countSentToRecipientSince(recipient: string, since: Date): Promise<number> {
  return MessageOutbox.count({ where: { status: "SENT", recipient, sent_at: { [Op.gte]: since } } });
}

/** The latest message of each registration (for staff replies): one query for a whole page. */
async function latestByRegistrations(
  organizationId: string,
  registrationIds: string[],
  options: RepoOptions = {},
): Promise<Map<string, Pick<MessageOutboxRow, "status" | "sent_at">>> {
  if (registrationIds.length === 0) return new Map();
  const rows = await MessageOutbox.findAll({
    where: { organization_id: organizationId, registration_id: registrationIds },
    attributes: ["registration_id", "status", "sent_at", "created_at"],
    order: [
      ["created_at", "DESC"],
      ["id", "DESC"],
    ],
    raw: true,
    ...txOptions(options),
  });
  const latest = new Map<string, Pick<MessageOutboxRow, "status" | "sent_at">>();
  for (const row of rows as unknown as MessageOutboxRow[]) {
    if (row.registration_id !== null && !latest.has(row.registration_id)) latest.set(row.registration_id, { status: row.status, sent_at: row.sent_at });
  }
  return latest;
}

/** Phase 7: the latest message of each order (the buyer's order confirmation), for the tickets of a page. One query. */
async function latestByOrders(
  organizationId: string,
  orderIds: string[],
  options: RepoOptions = {},
): Promise<Map<string, Pick<MessageOutboxRow, "status" | "sent_at">>> {
  if (orderIds.length === 0) return new Map();
  const rows = await MessageOutbox.findAll({
    where: { organization_id: organizationId, order_id: orderIds },
    attributes: ["order_id", "status", "sent_at", "created_at"],
    order: [
      ["created_at", "DESC"],
      ["id", "DESC"],
    ],
    raw: true,
    ...txOptions(options),
  });
  const latest = new Map<string, Pick<MessageOutboxRow, "status" | "sent_at">>();
  for (const row of rows as unknown as MessageOutboxRow[]) {
    if (row.order_id !== null && !latest.has(row.order_id)) latest.set(row.order_id, { status: row.status, sent_at: row.sent_at });
  }
  return latest;
}

export const messageOutboxRepository = {
  create,
  claimDue,
  markSent,
  markForRetry,
  markFinal,
  countSentSince,
  countSentToRecipientSince,
  latestByRegistrations,
  latestByOrders,
};
