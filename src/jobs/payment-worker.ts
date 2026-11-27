import { paymentConfig } from "../config/payment.js";
import { paymentService } from "../services/payment.service.js";
import { logger } from "../utils/logger.js";

/**
 * Phase 7 step 3: every PAYMENT_POLL_INTERVAL_MS, releases unpaid holds past their time. Never two ticks at once.
 * Started by server.ts only (never by app.ts, so tests don't start it).
 */
export function startPaymentWorker(): { stop: () => Promise<void> } {
  const { enabled, pollIntervalMs } = paymentConfig.worker;
  if (!enabled) {
    logger.info("Payment worker disabled (PAYMENT_WORKER_ENABLED=false)");
    return { stop: () => Promise.resolve() };
  }

  let running: Promise<void> | null = null;
  const tick = () => {
    if (running) return;
    running = paymentService
      .processDue()
      .then((summary) => {
        if (summary.expired > 0 || summary.checked > 0) logger.info(summary, "Payment worker");
      })
      .catch((error: unknown) => {
        logger.error({ err: error instanceof Error ? { name: error.name, message: error.message } : error }, "Payment worker failed");
      })
      .finally(() => {
        running = null;
      });
  };

  const timer = setInterval(tick, pollIntervalMs);
  timer.unref();
  logger.info({ pollIntervalMs }, "Payment worker started");

  return {
    stop: async () => {
      clearInterval(timer);
      await running;
    },
  };
}
