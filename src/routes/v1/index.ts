import { Router } from "express";
import { env } from "../../config/env.js";
import { authRouter } from "./auth.js";
import { branchesRouter } from "./branches.js";
import { customerAccountsRouter } from "./customer-accounts.js";
import { docsRouter } from "./docs.js";
import { eventsRouter } from "./events.js";
import { organizationsRouter } from "./organizations.js";
import { publicEventsRouter } from "./public-events.js";
import { ticketTypesRouter } from "./ticket-types.js";
import { venuesRouter } from "./venues.js";

/** The v1 mount table. One literal registration per resource router; each router mounted exactly once. */
export const router = Router();

router.use("/auth", authRouter);
router.use("/organizations", organizationsRouter);
router.use("/organizations/:organizationId/branches", branchesRouter);
router.use("/organizations/:organizationId/customer-accounts", customerAccountsRouter);
router.use("/organizations/:organizationId/venues", venuesRouter);
router.use("/organizations/:organizationId/events", eventsRouter);
router.use("/organizations/:organizationId/events/:eventId/ticket-types", ticketTypesRouter);
router.use("/public", publicEventsRouter); // no login: catalog and event pages

if (env.API_DOCS_ENABLED) {
  router.use(docsRouter); // GET /v1/openapi.json, /v1/docs
}
