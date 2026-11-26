import { createServer } from "node:http";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { smsConfig } from "./config/sms.js";
import { sequelize } from "./db.js";
import { startOutboxWorker } from "./jobs/outbox-worker.js";
import { startPaymentWorker } from "./jobs/payment-worker.js";
import { lifecycle } from "./utils/lifecycle.js";
import { logger } from "./utils/logger.js";

const SHUTDOWN_TIMEOUT_MS = 15_000;

const server = createServer(createApp());

server.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, "API listening");
});

// Confirmation SMS delivery (Phase 4c). In log mode nothing leaves the server: say so loudly in production.
if (env.NODE_ENV === "production" && smsConfig.delivery === "log") {
  logger.warn("SMS_DELIVERY=log in production: confirmation SMS are only logged, never sent");
}
const outboxWorker = startOutboxWorker();
const paymentWorker = startPaymentWorker();

async function shutdown(reason: string, exitCode: number): Promise<void> {
  if (lifecycle.shuttingDown) return;
  lifecycle.shuttingDown = true; // readiness probe now returns 503
  logger.info({ reason }, "Shutting down");

  const forceExit = setTimeout(() => {
    logger.error("Graceful shutdown timed out; forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  // Stop accepting connections, let in-flight requests finish, then release the DB pool.
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections();
  });
  await outboxWorker.stop();
  await paymentWorker.stop();
  await sequelize.close();
  process.exit(exitCode);
}

process.once("SIGTERM", () => void shutdown("SIGTERM", 0));
process.once("SIGINT", () => void shutdown("SIGINT", 0));
process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "Unhandled promise rejection");
  void shutdown("unhandledRejection", 1);
});
