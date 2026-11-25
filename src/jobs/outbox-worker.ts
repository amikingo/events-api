import { smsConfig } from "../config/sms.js";
import { outboxDeliveryService } from "../services/outbox-delivery.service.js";
import { logger } from "../utils/logger.js";

/**
 * Runs the outbox delivery every OUTBOX_POLL_INTERVAL_MS, never two ticks at once. Started by server.ts only (never by
 * app.ts, so tests don't start it); several API instances may run it together (claims use SKIP LOCKED).
 */
export function startOutboxWorker(): { stop: () => Promise<void> } {
  const { enabled, pollIntervalMs } = smsConfig.worker;
  if (!enabled) {
    logger.info("Outbox worker disabled (OUTBOX_WORKER_ENABLED=false)");
    return { stop: () => Promise.resolve() };
  }

  let running: Promise<void> | null = null;
  const tick = () => {
    if (running) return; // the previous tick is still sending
    running = outboxDeliveryService
      .processDue()
      .then((summary) => {
        if (summary.claimed > 0) logger.info(summary, "Outbox delivery");
      })
      .catch((error: unknown) => {
        logger.error({ err: error instanceof Error ? { name: error.name, message: error.message } : error }, "Outbox delivery failed");
      })
      .finally(() => {
        running = null;
      });
  };

  const timer = setInterval(tick, pollIntervalMs);
  timer.unref();
  logger.info({ pollIntervalMs, delivery: smsConfig.delivery }, "Outbox worker started");

  return {
    stop: async () => {
      clearInterval(timer);
      await running; // let a tick in progress finish before the database pool closes
    },
  };
}
