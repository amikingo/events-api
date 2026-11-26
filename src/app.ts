import { randomUUID } from "node:crypto";
import cors, { type CorsOptions } from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { env } from "./config/env.js";
import { filesConfig } from "./config/files.js";
import { errorHandler, notFound } from "./middleware/error-handler.js";
import "./models/index.js"; // initialize models + associations before any repository runs
import { rootRouter } from "./routes/index.js";
import { logger } from "./utils/logger.js";

const corsOptions: CorsOptions = {
  // Explicit allowlist. Never reflect arbitrary origins when credentials are allowed.
  origin: (origin, callback) => {
    callback(null, !origin || env.CORS_ALLOWED_ORIGINS.includes(origin.replace(/\/$/, "")));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept", "Origin", "X-Requested-With", "Idempotency-Key", "X-Request-Id"],
  exposedHeaders: ["X-Request-Id"],
  optionsSuccessStatus: 204,
  maxAge: 600,
};

/** Builds the HTTP app without listening, so tests can mount it on an ephemeral port. */
export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", env.TRUST_PROXY_HOPS); // hop count, never `true`: rate limits key on client IP

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers["x-request-id"];
        const id = typeof incoming === "string" && /^[\w.-]{1,128}$/.test(incoming) ? incoming : randomUUID();
        res.setHeader("X-Request-Id", id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url?.startsWith("/health") ?? false },
    }),
  );
  app.use(
    helmet({
      // upgrade-insecure-requests breaks the docs UI on plain-HTTP dev/test hosts; keep it for production.
      contentSecurityPolicy: { directives: { upgradeInsecureRequests: env.NODE_ENV === "production" ? [] : null } },
    }),
  );
  app.use(cors(corsOptions));

  // Uploaded files (event covers) served from FILES_DIR. Names are random UUIDs and never reused, so they can be
  // cached for a year. CORP cross-origin lets the booking site show them in <img> (helmet's default is same-origin).
  app.use(
    filesConfig.publicPath,
    express.static(filesConfig.rootDir, {
      index: false,
      redirect: false, // a folder is a plain 404, never a redirect that reveals it exists
      dotfiles: "deny",
      fallthrough: true, // anything not served falls through to the JSON 404
      immutable: true,
      maxAge: "365d",
      setHeaders: (res) => {
        res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
        res.setHeader("X-Content-Type-Options", "nosniff");
      },
    }),
  );

  app.use(
    express.json({
      limit: env.JSON_BODY_LIMIT,
      // Cheche Pay webhooks are signed over the exact bytes received, so those (only) are kept.
      verify: (req, _res, buf) => {
        if ((req as express.Request).originalUrl.startsWith("/v1/payments/cheche/webhook/")) (req as express.Request).rawBody = Buffer.from(buf);
      },
    }),
  );

  app.use(rootRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
