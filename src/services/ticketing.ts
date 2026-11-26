import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Transaction } from "sequelize";
import { CapacityReachedError, PurchaseLimitReachedError, RegistrationClosedError } from "../errors/app-errors.js";
import { registrationClosedReason } from "../mappers/event.mapper.js";
import type { EventRow } from "../models/event.js";
import type { OrderConfirmationPayload } from "../models/message-outbox.js";
import type { RegistrationSource } from "../models/registration.js";
import type { TicketOrderRow } from "../models/ticket-order.js";
import type { TicketTypeRow } from "../models/ticket-type.js";
import { messageOutboxRepository } from "../repositories/message-outbox.repository.js";
import { organizationRepository } from "../repositories/organization.repository.js";
import { registrationRepository } from "../repositories/registration.repository.js";
import { ticketOrderRepository } from "../repositories/ticket-order.repository.js";
import { generateOrderReference, generateRegistrationCode } from "../utils/registration-code.js";
import { ensureFound } from "./helpers.js";

/**
 * The rules every way of getting a ticket shares (Phase 7): the single-ticket endpoints (registration.service),
 * checkout (checkout.service) and paid-order confirmation (payment.service), so they can't drift apart. All of them
 * run under the event lock, which serializes every ticket change of the event: the counts read here can't change
 * before the caller writes.
 */
export const MAX_TICKETS_PER_ORDER = 20;
const MAX_CODE_ATTEMPTS = 5;
const CODES_PER_SMS = 10;

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
 * included; held ones too; cancelled and released ones don't count) plus `requested` must stay within it. No limit,
 * or no buyer mobile, means nothing to check. `buyerMobile` is E.164, so "0911…" and "+251911…" are the same buyer.
 */
async function assertBuyerAllowance(event: EventRow, buyerMobile: string | null, requested: number, transaction: Transaction): Promise<void> {
  if (event.purchase_limit_per_mobile === null || buyerMobile === null) return;
  const held = await registrationRepository.countConfirmedByBuyerMobile(event.organization_id, event.id, buyerMobile, { transaction });
  if (held + requested > event.purchase_limit_per_mobile) {
    throw new PurchaseLimitReachedError(undefined, { limit: event.purchase_limit_per_mobile, held, requested });
  }
}

/** The event's capacity and each ticket type's own limit, for a whole order at once (places taken: confirmed and held). */
async function assertRoom(event: EventRow, demand: ReadonlyArray<{ ticketType: TicketTypeRow; quantity: number }>, transaction: Transaction): Promise<void> {
  const total = demand.reduce((sum, { quantity }) => sum + quantity, 0);
  if (event.capacity !== null) {
    const taken = await registrationRepository.countConfirmedByEvent(event.organization_id, event.id, { transaction });
    if (taken + total > event.capacity) {
      throw new CapacityReachedError("Not enough places are left at this event", { scope: "EVENT", capacity: event.capacity, remaining: Math.max(0, event.capacity - taken) });
    }
  }
  for (const { ticketType, quantity } of demand) {
    if (ticketType.capacity === null) continue;
    const taken = await registrationRepository.countConfirmedByTicketType(event.organization_id, event.id, ticketType.id, { transaction });
    if (taken + quantity > ticketType.capacity) {
      throw new CapacityReachedError("Not enough places are left for this ticket type", {
        scope: "TICKET_TYPE",
        ticket_type_code: ticketType.code,
        capacity: ticketType.capacity,
        remaining: Math.max(0, ticketType.capacity - taken),
      });
    }
  }
}

/**
 * Phase 7 step 3: pending orders of the event whose hold has run out give their places back (tickets RELEASED, the
 * order EXPIRED), so a stale hold never blocks a sale. Runs under the event lock, before anything is counted. A
 * payment that still arrives later is handled by paymentService (it takes the places again if they're free).
 */
async function releaseExpiredHolds(event: EventRow, now: Date, transaction: Transaction): Promise<void> {
  const expired = await ticketOrderRepository.listExpiredPendingByEvent(event.organization_id, event.id, now, { transaction });
  for (const order of expired) {
    await registrationRepository.releaseHeldByOrder(event.organization_id, event.id, order.id, { transaction });
    await ticketOrderRepository.updateById(event.organization_id, order.id, { status: "EXPIRED" }, { transaction });
  }
}

/** One SMS to the buyer with every code (several when there are more than 10); none without a buyer mobile. */
async function queueOrderConfirmation(event: EventRow, order: TicketOrderRow, codes: string[], transaction: Transaction): Promise<void> {
  if (order.buyer_mobile === null || codes.length === 0) return;
  const organization = ensureFound(await organizationRepository.findById(event.organization_id, { transaction }), "Organization not found");
  const parts = Math.ceil(codes.length / CODES_PER_SMS);
  for (let part = 0; part < parts; part += 1) {
    const payload: OrderConfirmationPayload = {
      organization_name: organization.name,
      event_name: event.name,
      starts_at: event.starts_at === null ? null : event.starts_at.toISOString(),
      timezone: event.timezone,
      ticket_count: codes.length,
      codes: codes.slice(part * CODES_PER_SMS, (part + 1) * CODES_PER_SMS),
      part: part + 1,
      parts,
    };
    await messageOutboxRepository.create(
      { organization_id: event.organization_id, registration_id: null, order_id: order.id, kind: "ORDER_CONFIRMATION", channel: "SMS", recipient: order.buyer_mobile, payload },
      { transaction },
    );
  }
}

/**
 * Phase 7 step 3: the order token, the buyer's key to their order without an account. Random (32 bytes); only its
 * SHA-256 is stored, so a database read never reveals it.
 */
function newOrderToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashOrderToken(token) };
}

function hashOrderToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time comparison of a presented token with the stored hash. */
function orderTokenMatches(token: string, storedHash: string | null): boolean {
  if (storedHash === null) return false;
  const presented = Buffer.from(hashOrderToken(token), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}

export const ticketing = {
  assertTakingRegistrations,
  visibleTo,
  newCode,
  newOrderReference,
  assertBuyerAllowance,
  assertRoom,
  releaseExpiredHolds,
  queueOrderConfirmation,
  newOrderToken,
  orderTokenMatches,
};
