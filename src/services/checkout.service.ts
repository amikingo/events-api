import type { Transaction } from "sequelize";
import {
  CapacityReachedError,
  IdempotencyKeyReusedError,
  NotFoundError,
  PaymentRequiredError,
  TicketTypeInactiveError,
  ValidationAppError,
} from "../errors/app-errors.js";
import { toOrderDto, toOrderSummaryDto, type OrderDto, type OrderSummaryDto } from "../mappers/order.mapper.js";
import type { EventRow } from "../models/event.js";
import type { OrderConfirmationPayload } from "../models/message-outbox.js";
import type { RegistrationRow } from "../models/registration.js";
import type { SubmissionScope } from "../models/submission-key.js";
import type { OrderSource, TicketOrderRow } from "../models/ticket-order.js";
import type { TicketTypeRow } from "../models/ticket-type.js";
import { eventRepository } from "../repositories/event.repository.js";
import { messageOutboxRepository } from "../repositories/message-outbox.repository.js";
import { organizationRepository } from "../repositories/organization.repository.js";
import { personRepository } from "../repositories/person.repository.js";
import { registrationRepository } from "../repositories/registration.repository.js";
import { submissionKeyRepository } from "../repositories/submission-key.repository.js";
import { ticketOrderRepository } from "../repositories/ticket-order.repository.js";
import { ticketTypeRepository } from "../repositories/ticket-type.repository.js";
import { holderFieldIssues, isEmptyHolder, type HolderDetails, type HolderFieldIssue } from "../utils/holder-fields.js";
import { isZeroAmount, multiplyAmount, sumAmounts } from "../utils/money.js";
import { buildPagination } from "../utils/pagination.js";
import { requestHash } from "../utils/request-hash.js";
import type { OrderListQuery, StaffOrderInput } from "../validators/order.js";
import { ensureFound, runTransaction } from "./helpers.js";
import { MAX_TICKETS_PER_ORDER, ticketing } from "./ticketing.js";

/**
 * Checkout (Phase 7 step 2): one buyer, one event, one or more ticket types with whole quantities, in one order.
 * All or nothing, under the same lock order as every other place change: the event, then the chosen ticket types
 * in id order. Every check runs before anything is written:
 * 1. the event takes registrations; 2. each ticket type exists, is active and open to the caller (STAFF_ONLY for
 * staff only); 3. at most 20 tickets; 4. a DETAILED event's holder details (one holder per ticket, its required and
 * hidden fields); 5. prices from the server (a positive total is 409 payment_required until paid checkout, step 3);
 * 6. the event's and each type's capacity for the whole order; 7. the buyer mobile's purchase limit.
 * Then the order, one ticket per unit (its own code and its price at checkout; a holder profile when DETAILED, none
 * when QUICK), and one SMS to the buyer with every code (split every 10 codes), all in the caller's transaction.
 */
const CODES_PER_SMS = 10;

export type CheckoutItem = {
  /** Staff choose by id; the public form by code. */
  ticketTypeId?: string | undefined;
  ticketTypeCode?: string | undefined;
  quantity: number;
  /** A DETAILED event's holders, one per ticket (the validated request fields). */
  holders?: HolderDetails[] | undefined;
};

export type CheckoutInput = {
  organizationId: string;
  eventId: string;
  source: OrderSource;
  actorId: string | null;
  /** The delivery mobile (E.164) and, when signed in, the buyer's verified Cheche account. */
  buyer: { mobile: string | null; userId: string | null };
  items: CheckoutItem[];
  /** Privacy-notice evidence from the public form; staff checkout has none. */
  evidence?: { privacyNoticeVersion: string; shownAt: Date } | undefined;
};

export type CheckoutResult = { order: TicketOrderRow; tickets: RegistrationRow[] };
export type CheckoutRequest = { scope: Extract<SubmissionScope, "PUBLIC_CHECKOUT" | "STAFF_CHECKOUT">; key: string; requestHash: string };
export type CheckoutOutcome = "CREATED" | "REPLAYED";

type ResolvedItem = { item: CheckoutItem; index: number; ticketType: TicketTypeRow };

/** Each item's ticket type: found by id or code, open to the caller, then all locked in id order, active. */
async function lockTicketTypes(input: CheckoutInput, transaction: Transaction): Promise<ResolvedItem[]> {
  const { organizationId, eventId, source } = input;
  const ids: string[] = [];
  for (const [index, item] of input.items.entries()) {
    const found =
      item.ticketTypeId !== undefined
        ? await ticketTypeRepository.findByEventAndId(organizationId, eventId, item.ticketTypeId, { transaction })
        : await ticketTypeRepository.findByEventAndCode(organizationId, eventId, item.ticketTypeCode ?? "", { transaction });
    // A STAFF_ONLY type is "not found" for the public, even by its code.
    if (!found || !ticketing.visibleTo(source)(found)) {
      throw new NotFoundError("Ticket type not found", { item: index, ticket_type: item.ticketTypeCode ?? item.ticketTypeId });
    }
    ids.push(found.id);
  }
  if (new Set(ids).size !== ids.length) {
    throw new ValidationAppError("Request validation failed", {
      issues: [{ path: "body.items", message: "Each ticket type may appear only once; raise its quantity instead", code: "duplicate_ticket_type" }],
    });
  }

  const locked = new Map<string, TicketTypeRow>();
  for (const id of [...ids].sort()) {
    locked.set(id, ensureFound(await ticketTypeRepository.findByEventAndId(organizationId, eventId, id, { transaction, lock: true }), "Ticket type not found"));
  }
  return input.items.map((item, index) => {
    const ticketType = locked.get(ids[index] as string) as TicketTypeRow;
    if (!ticketType.is_active) throw new TicketTypeInactiveError(undefined, { item: index, ticket_type_code: ticketType.code });
    return { item, index, ticketType };
  });
}

/** One holder per ticket for DETAILED events, each following the event's holder fields; none for QUICK events. */
function assertHolders(event: EventRow, resolved: ResolvedItem[]): void {
  const issues: Array<HolderFieldIssue | { path: string; message: string; code: "holders_count" }> = [];
  for (const { item, index } of resolved) {
    const path = `body.items.${index}.holders`;
    if (event.registration_mode === "QUICK") {
      if (item.holders !== undefined) issues.push({ path, message: "This event doesn't collect ticket holders' details", code: "not_collected" });
      continue;
    }
    if (item.holders === undefined || item.holders.length !== item.quantity) {
      issues.push({ path, message: `Send one holder for each of the ${item.quantity} tickets`, code: "holders_count" });
      continue;
    }
    item.holders.forEach((holder, holderIndex) => issues.push(...holderFieldIssues(event.holder_fields, holder, `${path}.${holderIndex}`)));
  }
  if (issues.length > 0) throw new ValidationAppError("Request validation failed", { issues });
}

/** The event's capacity and each ticket type's own limit, for the whole order at once. */
async function assertRoomFor(event: EventRow, resolved: ResolvedItem[], total: number, transaction: Transaction): Promise<void> {
  if (event.capacity !== null) {
    const taken = await registrationRepository.countConfirmedByEvent(event.organization_id, event.id, { transaction });
    if (taken + total > event.capacity) {
      throw new CapacityReachedError("Not enough places are left at this event", { scope: "EVENT", capacity: event.capacity, remaining: Math.max(0, event.capacity - taken) });
    }
  }
  for (const { ticketType, item } of resolved) {
    if (ticketType.capacity === null) continue;
    const taken = await registrationRepository.countConfirmedByTicketType(event.organization_id, event.id, ticketType.id, { transaction });
    if (taken + item.quantity > ticketType.capacity) {
      throw new CapacityReachedError("Not enough places are left for this ticket type", {
        scope: "TICKET_TYPE",
        ticket_type_code: ticketType.code,
        capacity: ticketType.capacity,
        remaining: Math.max(0, ticketType.capacity - taken),
      });
    }
  }
}

/** The total from the server's prices; one currency per order. */
function priceOrder(resolved: ResolvedItem[]): { total: string; currency: string } {
  const currencies = new Set(resolved.map(({ ticketType }) => ticketType.currency));
  if (currencies.size > 1) {
    throw new ValidationAppError("Request validation failed", {
      issues: [{ path: "body.items", message: "These ticket types are priced in different currencies; order them separately", code: "mixed_currency" }],
    });
  }
  const total = sumAmounts(resolved.map(({ ticketType, item }) => multiplyAmount(ticketType.price, item.quantity)));
  return { total, currency: (resolved[0] as ResolvedItem).ticketType.currency };
}

/** One SMS to the buyer with every code (several when there are more than 10), only for an Ethiopian mobile. */
async function queueOrderConfirmation(event: EventRow, order: TicketOrderRow, tickets: RegistrationRow[], transaction: Transaction): Promise<void> {
  if (order.buyer_mobile === null) return;
  const organization = ensureFound(await organizationRepository.findById(event.organization_id, { transaction }), "Organization not found");
  const codes = tickets.map((ticket) => ticket.code);
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

/** The checkout core. See the module comment for the order of checks; nothing is written before all of them pass. */
async function checkoutInTransaction(input: CheckoutInput, transaction: Transaction): Promise<CheckoutResult> {
  const { organizationId, eventId, source, actorId } = input;
  if (source === "STAFF" && actorId === null) throw new Error("A staff order needs the staff member's id");
  const now = new Date();

  const event = ensureFound(await eventRepository.findByOrganizationAndId(organizationId, eventId, { transaction, lock: true }), "Event not found");
  ticketing.assertTakingRegistrations(event, now);
  const resolved = await lockTicketTypes(input, transaction);
  const count = resolved.reduce((sum, { item }) => sum + item.quantity, 0);
  if (count > MAX_TICKETS_PER_ORDER) {
    throw new ValidationAppError("Request validation failed", {
      issues: [{ path: "body.items", message: `At most ${MAX_TICKETS_PER_ORDER} tickets per order`, code: "too_many_tickets" }],
    });
  }
  assertHolders(event, resolved);
  const { total, currency } = priceOrder(resolved);
  if (!isZeroAmount(total)) throw new PaymentRequiredError("This order has a price: paid checkout isn't available yet", { total_amount: total, currency });
  await assertRoomFor(event, resolved, count, transaction);
  await ticketing.assertBuyerAllowance(event, input.buyer.mobile, count, transaction);

  const order = await ticketOrderRepository.create(
    {
      organization_id: organizationId,
      event_id: eventId,
      reference: await ticketing.newOrderReference(transaction),
      source,
      status: "CONFIRMED",
      buyer_mobile: input.buyer.mobile,
      buyer_user_id: input.buyer.userId,
      total_amount: total,
      currency,
      created_by: actorId,
      updated_by: actorId,
    },
    { transaction },
  );

  const registeredBy = source === "STAFF" ? actorId : null;
  const tickets: RegistrationRow[] = [];
  for (const { item, ticketType } of resolved) {
    for (let unit = 0; unit < item.quantity; unit += 1) {
      const holder = item.holders?.[unit];
      const person =
        event.registration_mode === "DETAILED" && holder && !isEmptyHolder(holder)
          ? await personRepository.create(
              {
                organization_id: organizationId,
                first_name: holder.first_name as string,
                last_name: holder.last_name ?? null,
                email: holder.email ?? null,
                phone: holder.phone ?? null,
                affiliation_name: holder.affiliation_name ?? null,
                country: holder.country ?? null,
                is_active: true,
                user_id: null,
                created_by: actorId,
                updated_by: actorId,
              },
              { transaction },
            )
          : null;
      tickets.push(
        await registrationRepository.create(
          {
            organization_id: organizationId,
            event_id: eventId,
            person_id: person?.id ?? null,
            order_id: order.id,
            ticket_type_id: ticketType.id,
            price_amount: ticketType.price,
            currency: ticketType.currency,
            status: "CONFIRMED",
            source,
            registered_by: registeredBy,
            registered_at: now,
            cancelled_at: null,
            code: await ticketing.newCode(transaction),
            privacy_notice_version: input.evidence?.privacyNoticeVersion ?? null,
            privacy_notice_shown_at: input.evidence?.shownAt ?? null,
            consent_purpose: null,
            consent_version: null,
            consented_at: null,
            created_by: actorId,
            updated_by: actorId,
          },
          { transaction },
        ),
      );
    }
  }

  await queueOrderConfirmation(event, order, tickets, transaction);
  return { order, tickets };
}

/**
 * Checkout behind a retry key (the registerOnce pattern). The event is locked first, so retries of one submission
 * are decided one after the other. The same key with the same request returns the original order and codes (no new
 * ticket, place or SMS); the same key with another request is refused. Only a successful order stores its key.
 */
async function checkoutOnce(input: CheckoutInput, submission: CheckoutRequest, transaction: Transaction): Promise<{ order: TicketOrderRow; outcome: CheckoutOutcome }> {
  const { organizationId, eventId } = input;
  ensureFound(await eventRepository.findByOrganizationAndId(organizationId, eventId, { transaction, lock: true }), "Event not found");

  const earlier = await submissionKeyRepository.findByScopeAndKey(organizationId, submission.scope, submission.key, { transaction });
  if (earlier) {
    if (earlier.request_hash !== submission.requestHash || earlier.order_id === null) throw new IdempotencyKeyReusedError();
    const order = ensureFound(await ticketOrderRepository.findByEventAndId(organizationId, eventId, earlier.order_id, { transaction }), "Order not found");
    return { order, outcome: "REPLAYED" };
  }

  const { order } = await checkoutInTransaction(input, transaction);
  await submissionKeyRepository.create(
    { organization_id: organizationId, scope: submission.scope, key: submission.key, request_hash: submission.requestHash, registration_id: null, order_id: order.id },
    { transaction },
  );
  return { order, outcome: "CREATED" };
}

/** The order with its tickets and its confirmation SMS, for staff. */
async function orderDto(organizationId: string, eventId: string, orderId: string, transaction?: Transaction): Promise<OrderDto> {
  const options = { transaction: transaction ?? null };
  const order = ensureFound(await ticketOrderRepository.findByEventAndId(organizationId, eventId, orderId, options), "Order not found");
  const tickets = await registrationRepository.listByOrder(organizationId, eventId, orderId, options);
  const confirmation = (await messageOutboxRepository.latestByOrders(organizationId, [orderId], options)).get(orderId) ?? null;
  return toOrderDto(order, tickets, confirmation);
}

/** Staff checkout: any active ticket type, STAFF_ONLY included; the buyer mobile is optional (no SMS without one). */
async function createStaffOrder(
  organizationId: string,
  eventId: string,
  body: StaffOrderInput,
  actorId: string | null,
  idempotencyKey?: string,
): Promise<{ order: OrderDto; outcome: CheckoutOutcome }> {
  return runTransaction(async (transaction) => {
    const input: CheckoutInput = {
      organizationId,
      eventId,
      source: "STAFF",
      actorId,
      buyer: { mobile: body.buyer_mobile ?? null, userId: null },
      items: body.items.map((item) => ({ ticketTypeId: item.ticket_type_id, quantity: item.quantity, holders: item.holders })),
    };
    const { order, outcome } =
      idempotencyKey === undefined
        ? { ...(await checkoutInTransaction(input, transaction)), outcome: "CREATED" as const }
        : await checkoutOnce(input, { scope: "STAFF_CHECKOUT", key: idempotencyKey, requestHash: requestHash({ event_id: eventId, body }) }, transaction);
    return { order: await orderDto(organizationId, eventId, order.id, transaction), outcome };
  });
}

async function listOrders(organizationId: string, eventId: string, query: OrderListQuery): Promise<{ rows: OrderSummaryDto[]; count: number }> {
  ensureFound(await eventRepository.findByOrganizationAndId(organizationId, eventId), "Event not found");
  const { limit, offset } = buildPagination(query);
  const { rows, count } = await ticketOrderRepository.listByEvent(organizationId, eventId, { buyerMobile: query.buyer_mobile, limit, offset });
  return { rows: rows.map(toOrderSummaryDto), count };
}

async function getOrder(organizationId: string, eventId: string, orderId: string): Promise<OrderDto> {
  return orderDto(organizationId, eventId, orderId);
}

export const checkoutService = { checkoutInTransaction, checkoutOnce, createStaffOrder, listOrders, getOrder };
