import type { Request, Response } from "express";
import { registrationService } from "../services/registration.service.js";
import { sendSuccess } from "../utils/http.js";
import { getCustomerAuth } from "./helpers.js";

/** My Tickets (Phase 6): the signed-in guest's own registrations, across organizers. */
async function listMyTickets(req: Request, res: Response): Promise<void> {
  const tickets = await registrationService.listMyTickets(getCustomerAuth(req).userId);
  sendSuccess(res, 200, tickets, "Your tickets");
}

export const customerController = { listMyTickets };
