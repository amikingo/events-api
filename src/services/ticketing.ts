import type { Transaction } from "sequelize";
import { PurchaseLimitReachedError, RegistrationClosedError } from "../errors/app-errors.js";
import { registrationClosedReason } from "../mappers/event.mapper.js";
import type { EventRow } from "../models/event.js";
import type { RegistrationSource } from "../models/registration.js";
import type { TicketTypeRow } from "../models/ticket-type.js";
import { registrationRepository } from "../repositories/registration.repository.js";
import { ticketOrderRepository } from "../repositories/ticket-order.repository.js";
import { generateOrderReference, generateRegistrationCode } from "../utils/registration-code.js";

/**
 * The rules every way of getting a ticket shares (Phase 7): the single-ticket endpoints (registration.service) and
 * checkout (checkout.service), so they can't drift apart. All of them run under the event lock, which serializes
 * every ticket change of the event: the counts read here can't change before the caller writes.
 */
export const MAX_TICKETS_PER_ORDER = 20;
const MAX_CODE_ATTEMPTS = 5;

function assertTakingRegistrations(event: EventRow, now: Date): void {
  const reason = registrationClosedReason(event, now);
  if (reason) throw new RegistrationClosedError("This event is not taking registrations", { reason });
}

/** The public only ever sees PUBLIC ticket types; staff may issue STAFF_ONLY ones too. */
const visibleTo =
  (source: RegistrationSource) =>
  (ticketType: TicketTypeRow): boolean =>
    source === "STAFF" || ticketType.audience === "PUBLIC";

async function newCode(transaction: Transaction): Promise<string> {
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
    const code = generateRegistrationCode();
    if (!(await registrationRepository.codeExists(code, { transaction }))) return code;
  }
  throw new Error("Could not generate a free registration code");
}

async function newOrderReference(transaction: Transaction): Promise<string> {
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
    const reference = generateOrderReference();
    if (!(await ticketOrderRepository.referenceExists(reference, { transaction }))) return reference;
  }
  throw new Error("Could not generate a free order reference");
}

/**
 * The event's purchase limit: the tickets this buyer mobile already holds at the event (every order, staff ones
 * included; cancelled ones don't count) plus `requested` must stay within it. No limit, or no buyer mobile, means
 * nothing to check. `buyerMobile` is E.164, so "0911…" and "+251911…" are the same buyer.
 */
async function assertBuyerAllowance(event: EventRow, buyerMobile: string | null, requested: number, transaction: Transaction): Promise<void> {
  if (event.purchase_limit_per_mobile === null || buyerMobile === null) return;
  const held = await registrationRepository.countConfirmedByBuyerMobile(event.organization_id, event.id, buyerMobile, { transaction });
  if (held + requested > event.purchase_limit_per_mobile) {
    throw new PurchaseLimitReachedError(undefined, { limit: event.purchase_limit_per_mobile, held, requested });
  }
}

export const ticketing = { assertTakingRegistrations, visibleTo, newCode, newOrderReference, assertBuyerAllowance };
