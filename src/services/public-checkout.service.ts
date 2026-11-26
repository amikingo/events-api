import { PRIVACY_NOTICE_VERSION } from "../config/privacy.js";
import { PrivacyNoticeOutdatedError, ValidationAppError } from "../errors/app-errors.js";
import { toPublicOrderDto, type PublicOrderDto } from "../mappers/order.mapper.js";
import type { CustomerAuthContext } from "../middleware/authentication.js";
import { eventRepository } from "../repositories/event.repository.js";
import { registrationRepository } from "../repositories/registration.repository.js";
import { requestHash } from "../utils/request-hash.js";
import type { PublicOrderInput } from "../validators/order.js";
import { checkoutService, type CheckoutOutcome } from "./checkout.service.js";
import { customerAuthService } from "./customer-auth.service.js";
import { ensureFound, runTransaction } from "./helpers.js";

/**
 * Public checkout (Phase 7 step 2): the checkout core behind a required retry key, on the public event link (the
 * same public rules as the event page: an active organization, published at least once).
 * - Without an account, `buyer_mobile` is required: the codes are sent there and the purchase limit counts by it.
 * - Signed in with a Cheche account, the account's verified mobile is the buyer mobile (never the form's) and the
 *   order is linked to the account, so its tickets appear in My Tickets. The account is part of the retry-key hash.
 * - Only PUBLIC ticket types can be chosen, by code; prices come from the server.
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

  return runTransaction(async (transaction) => {
    const { order, outcome } = await checkoutService.checkoutOnce(
      {
        organizationId: event.organization_id,
        eventId: event.id,
        source: "PUBLIC",
        actorId: null,
        buyer: { mobile: buyerMobile, userId: account?.userId ?? null },
        items: input.items.map((item) => ({ ticketTypeCode: item.ticket_type_code, quantity: item.quantity, holders: item.holders })),
        evidence: { privacyNoticeVersion: input.privacy_notice_version, shownAt: new Date() },
      },
      { scope: "PUBLIC_CHECKOUT", key: idempotencyKey, requestHash: requestHash({ event_id: event.id, body: input, user_id: account?.userId }) },
      transaction,
    );
    const tickets = await registrationRepository.listByOrder(event.organization_id, event.id, order.id, { transaction });
    return { order: toPublicOrderDto(order, tickets, event), outcome };
  });
}

export const publicCheckoutService = { checkoutFromPublicForm };
