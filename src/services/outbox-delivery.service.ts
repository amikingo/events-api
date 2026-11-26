import { smsClient } from "../clients/sms/index.js";
import { maskPhone } from "../clients/sms/sms-sender.js";
import { smsConfig } from "../config/sms.js";
import type { MessageOutboxRow } from "../models/message-outbox.js";
import { messageOutboxRepository } from "../repositories/message-outbox.repository.js";
import { messageText } from "../utils/confirmation-message.js";
import { logger } from "../utils/logger.js";

/**
 * Delivers queued messages after commit (spec rule 5), separately from the registration: a failed delivery is retried
 * without touching the registration or its place. Delivery is at least once: a crash between sending and recording
 * lets the lease expire, and that message may go out a second time.
 */
export type DeliverySummary = { claimed: number; sent: number; retried: number; failed: number; skipped: number };

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** Only the provider's own wording, never a token (senders never put one in their errors). */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown delivery error";
}

async function deliver(message: MessageOutboxRow, now: Date, summary: DeliverySummary): Promise<void> {
  if ((await messageOutboxRepository.countSentSince(new Date(now.getTime() - DAY_MS))) >= smsConfig.dailyLimit) {
    await messageOutboxRepository.markFinal(message.id, "SKIPPED", `Daily SMS limit (${smsConfig.dailyLimit}) reached`);
    summary.skipped += 1;
    logger.warn({ messageId: message.id }, "SMS skipped: daily limit reached");
    return;
  }
  const recent = await messageOutboxRepository.countSentToRecipientSince(message.recipient, new Date(now.getTime() - HOUR_MS));
  if (recent >= smsConfig.perRecipientHourlyLimit) {
    await messageOutboxRepository.markFinal(message.id, "SKIPPED", `More than ${smsConfig.perRecipientHourlyLimit} SMS to this number in an hour`);
    summary.skipped += 1;
    logger.warn({ messageId: message.id, to: maskPhone(message.recipient) }, "SMS skipped: too many to one number");
    return;
  }

  try {
    const { providerMessageId } = await smsClient.send({ to: message.recipient, text: messageText(message.kind, message.payload) });
    await messageOutboxRepository.markSent(message.id, new Date(), providerMessageId);
    summary.sent += 1;
  } catch (error) {
    const reason = errorText(error);
    const { maxAttempts, retryDelaysMs } = smsConfig.worker;
    if (message.attempts >= maxAttempts) {
      await messageOutboxRepository.markFinal(message.id, "FAILED", reason);
      summary.failed += 1;
      logger.error({ messageId: message.id, attempts: message.attempts, reason }, "SMS failed for good");
      return;
    }
    // attempts was raised by the claim: after the 1st failure wait 1 minute, then 5, 15 and 60.
    const delay = retryDelaysMs[message.attempts - 1] ?? HOUR_MS;
    await messageOutboxRepository.markForRetry(message.id, new Date(now.getTime() + delay), reason);
    summary.retried += 1;
    logger.warn({ messageId: message.id, attempts: message.attempts, reason }, "SMS failed; will retry");
  }
}

/** One worker tick: claim what is due (with a lease), then deliver each claimed message. */
async function processDue(now: Date = new Date()): Promise<DeliverySummary> {
  const { batchSize, leaseMs } = smsConfig.worker;
  const claimed = await messageOutboxRepository.claimDue(now, batchSize, leaseMs);
  const summary: DeliverySummary = { claimed: claimed.length, sent: 0, retried: 0, failed: 0, skipped: 0 };
  for (const message of claimed) await deliver(message, now, summary);
  return summary;
}

export const outboxDeliveryService = { processDue };
