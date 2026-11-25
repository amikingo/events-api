import type { CreationAttributes } from "sequelize";
import { MessageOutbox } from "../models/index.js";
import type { MessageOutboxRow } from "../models/message-outbox.js";
import { txOptions, type WriteOptions } from "./helpers.js";

/** Queues a message. Always called inside the transaction of the change it reports (spec rule 5). */
async function create(values: CreationAttributes<MessageOutbox>, options: WriteOptions = {}): Promise<MessageOutboxRow> {
  const row = await MessageOutbox.create(values, txOptions(options));
  return row.get({ plain: true });
}

export const messageOutboxRepository = { create };
