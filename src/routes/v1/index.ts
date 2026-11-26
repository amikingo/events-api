import { Router } from "express";
import { env } from "../../config/env.js";
import { authRouter } from "./auth.js";
import { branchesRouter } from "./branches.js";
import { customerAccountsRouter } from "./customer-accounts.js";
import { customerRouter } from "./customer.js";
import { docsRouter } from "./docs.js";
import { eventsRouter } from "./events.js";
import { grantableModulesRouter } from "./grantable-modules.js";
import { modulesRouter } from "./modules.js";
import { organizationsRouter } from "./organizations.js";
import { personsRouter } from "./persons.js";
import { platformRouter } from "./platform.js";
import { ordersRouter } from "./orders.js";
import { publicEventsRouter } from "./public-events.js";
import { registrationsRouter } from "./registrations.js";
import { organizationRoleTemplatesRouter, roleTemplatesRouter } from "./role-templates.js";
import { rolesRouter } from "./roles.js";
import { staffAssignmentsRouter } from "./staff-assignments.js";
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
router.use("/organizations/:organizationId/events/:eventId/registrations", registrationsRouter);
router.use("/organizations/:organizationId/events/:eventId/orders", ordersRouter);
router.use("/organizations/:organizationId/persons", personsRouter);
router.use("/organizations/:organizationId/roles", rolesRouter);
router.use("/organizations/:organizationId/role-templates", organizationRoleTemplatesRouter);
router.use("/organizations/:organizationId/grantable-modules", grantableModulesRouter);
router.use("/role-templates", roleTemplatesRouter); // platform scope: the Super Admin's template library
router.use("/modules", modulesRouter); // platform scope: the menu and permission list
router.use("/platform", platformRouter); // platform scope: platform roles and platform staff
router.use("/organizations/:organizationId", staffAssignmentsRouter); // /staff-assignments, /staff-lookup
router.use("/public", publicEventsRouter); // no login: catalog and event pages
router.use("/customer", customerRouter); // a signed-in guest's own data (My Tickets)

if (env.API_DOCS_ENABLED) {
  router.use(docsRouter); // GET /v1/openapi.json, /v1/docs
}
