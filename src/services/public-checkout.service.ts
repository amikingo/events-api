import { PRIVACY_NOTICE_VERSION } from "../config/privacy.js";
import { NotFoundError, PrivacyNoticeOutdatedError, ValidationAppError } from "../errors/app-errors.js";
import { toPublicOrderDto, type PublicOrderContext, type PublicOrderDto } from "../mappers/order.mapper.js";
import type { CustomerAuthContext } from "../middleware/authentication.js";
import type { TicketOrderRow } from "../models/ticket-order.js";
import { eventRepository } from "../repositories/event.repository.js";
import { orderPaymentRepository } from "../repositories/order-payment.repository.js";
import { organizationRepository } from "../repositories/organization.repository.js";
import { registrationRepository } from "../repositories/registration.repository.js";
import { ticketOrderRepository } from "../repositories/ticket-order.repository.js";
import { requestHash } from "../utils/request-hash.js";
import type { PublicOrderInput } from "../validators/order.js";
import { checkoutService, type CheckoutOutcome } from "./checkout.service.js";
import { customerAuthService } from "./customer-auth.service.js";
import { ensureFound, runTransaction } from "./helpers.js";
import { paymentService } from "./payment.service.js";
import { ticketing } from "./ticketing.js";

/**
 * Public checkout (Phase 7): the checkout core behind a required retry key, on the public event link (the same
 * public rules as the event page: an active organization, published at least once).
 * - Without an account, `buyer_mobile` is required: the codes are sent there and the purchase limit counts by it.
 * - Signed in with a Cheche account, the account's verified mobile is the buyer mobile (never the form's) and the
 *   order is linked to the account, so its tickets appear in My Tickets. The account is part of the retry-key hash.
 * - Only PUBLIC ticket types can be chosen, by code; prices come from the server.
 * - Step 3: the reply carries an order token, the buyer's key to the order page without an account. A paid order
 *   needs one of the organizer's Cheche Pay options (`payment_option_id`); its payment is started after the
 *   transaction commits, and the reply has the checkout URL (or none yet, if Cheche Pay is slow: the buyer retries
 *   through POST /v1/public/orders/{reference}/payment).
 */
async function checkoutFromPublicForm(
  organizationSlug: string,
  eventSlug: string,
  idempotencyKey: string,
  input: PublicOrderInput,
  account: CustomerAuthContext | null = null,
): Promise<{ order: PublicOrderDto; outcome: CheckoutOutcome }> {
  const event = ensureFound(await eventRepository.findPublishedBySlugs(organizationSlug, eventSlug), "Event not found");
  if (input.privacy_notice_version !== PRIVACY_NOTICE_VERSION) {
    throw new PrivacyNoticeOutdatedError(undefined, { current: PRIVACY_NOTICE_VERSION });
  }

  let buyerMobile: string;
  if (account) {
    // Outside the transaction: this may ask auth-cheche for the account's mobile.
    buyerMobile = (await customerAuthService.accountMobile(account, { required: true })) as string;
  } else {
    if (input.buyer_mobile === undefined) {
      throw new ValidationAppError("Request validation failed", {
        issues: [{ path: "body.buyer_mobile", message: "A mobile number is required: the tickets are sent there", code: "required" }],
      });
    }
    buyerMobile = input.buyer_mobile;
  }

  // A paid order's option is checked with Cheche Pay before the transaction: no network call under a lock.
  const payment = input.payment_option_id === undefined ? null : await paymentService.resolvePaymentOption(event.organization_id, input.payment_option_id);
  const { token, hash } = ticketing.newOrderToken();
  const { orderId, outcome } = await runTransaction(async (transaction) => {
    const result = await checkoutService.checkoutOnce(
      {
        organizationId: event.organization_id,
        eventId: event.id,
        source: "PUBLIC",
        actorId: null,
        buyer: { mobile: buyerMobile, userId: account?.userId ?? null },
        items: input.items.map((item) => ({ ticketTypeCode: item.ticket_type_code, quantity: item.quantity, holders: item.holders })),
        accessTokenHash: hash,
        payment,
        evidence: { privacyNoticeVersion: input.privacy_notice_version, shownAt: new Date() },
      },
      { scope: "PUBLIC_CHECKOUT", key: idempotencyKey, requestHash: requestHash({ event_id: event.id, body: input, user_id: account?.userId }) },
      transaction,
    );
    return { orderId: result.order.id, outcome: result.outcome };
  });
  await paymentService.startPaymentIfPending(event.organization_id, orderId);
  const order = ensureFound(await ticketOrderRepository.findByOrganizationAndId(event.organization_id, orderId), "Order not found");
  return { order: await buyerView(order, token), outcome };
}

/** The buyer's view of their order: tickets (codes once issued), payment and the event. */
async function buyerView(order: TicketOrderRow, orderToken: string | null = null): Promise<PublicOrderDto> {
  const event = ensureFound(await eventRepository.findByOrganizationAndId(order.organization_id, order.event_id), "Event not found");
  const organization = ensureFound(await organizationRepository.findById(order.organization_id), "Organization not found");
  const context: PublicOrderContext = {
    event: { name: event.name, slug: event.slug, starts_at: event.starts_at, ends_at: event.ends_at, timezone: event.timezone },
    organization: { name: organization.name, slug: organization.slug },
  };
  const tickets = await registrationRepository.listByOrder(order.organization_id, order.event_id, order.id);
  const payment = await orderPaymentRepository.findByOrder(order.organization_id, order.id);
  return toPublicOrderDto(order, tickets, context, payment, orderToken);
}

/** The order behind a reference, only with its token. A wrong token looks the same as an unknown reference (404). */
async function orderForToken(reference: string, token: string): Promise<TicketOrderRow> {
  const order = await ticketOrderRepository.findByReference(reference);
  if (!order || !ticketing.orderTokenMatches(token, order.access_token_hash)) throw new NotFoundError("Order not found");
  return order;
}

async function getOrder(reference: string, token: string): Promise<PublicOrderDto> {
  return buyerView(await orderForToken(reference, token));
}

/** Starts or resumes the payment (the same reference every time) and returns the order with the checkout URL. */
async function startPayment(reference: string, token: string): Promise<PublicOrderDto> {
  const order = await orderForToken(reference, token);
  await paymentService.startPayment(order.organization_id, order.id);
  return buyerView(ensureFound(await ticketOrderRepository.findByOrganizationAndId(order.organization_id, order.id), "Order not found"));
}

/** The organizer's Cheche Pay options for the event page ([] when paid sales are off). */
async function listPaymentOptions(organizationSlug: string, eventSlug: string): Promise<Array<{ id: string; name: string | null }>> {
  const event = ensureFound(await eventRepository.findPublishedBySlugs(organizationSlug, eventSlug), "Event not found");
  return paymentService.listOptionsForOrganization(event.organization_id);
}

export const publicCheckoutService = { checkoutFromPublicForm, getOrder, startPayment, listPaymentOptions };
