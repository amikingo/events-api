import { PRIVACY_NOTICE_VERSION } from "../config/privacy.js";
import { PrivacyNoticeOutdatedError, ValidationAppError } from "../errors/app-errors.js";
import { toPublicRegistrationDto, type PublicRegistrationDto } from "../mappers/registration.mapper.js";
import type { CustomerAuthContext } from "../middleware/authentication.js";
import { eventRepository } from "../repositories/event.repository.js";
import { registrationRepository } from "../repositories/registration.repository.js";
import { requestHash } from "../utils/request-hash.js";
import type { PublicRegistrationInput } from "../validators/public-registration.js";
import { customerAuthService } from "./customer-auth.service.js";
import { ensureFound, runTransaction } from "./helpers.js";
import { registrationService, type RegistrationGuest, type SubmissionOutcome } from "./registration.service.js";

/**
 * Public registration (Phase 4b): the same registration core as staff entry, behind a required retry key. The event
 * is found by both slugs with the public rules (an active organization, published at least once); the registration
 * rules then decide whether it takes sign-ups.
 * - Without an account, a visitor always gets a new, unlinked guest profile (spec §6): a matching name, phone or
 *   email never links two profiles.
 * - Signed in with a Cheche account (Phase 6), the account's linked profile in the organization is used or created,
 *   with the account's verified mobile (never the form's). Registering again for the same event returns the same
 *   registration (outcome UNCHANGED). The account is part of the retry-key hash.
 */
async function registerFromPublicForm(
  organizationSlug: string,
  eventSlug: string,
  idempotencyKey: string,
  input: PublicRegistrationInput,
  account: CustomerAuthContext | null = null,
): Promise<{ registration: PublicRegistrationDto; replayed: boolean; outcome: SubmissionOutcome }> {
  const event = ensureFound(await eventRepository.findPublishedBySlugs(organizationSlug, eventSlug), "Event not found");
  if (input.privacy_notice_version !== PRIVACY_NOTICE_VERSION) {
    throw new PrivacyNoticeOutdatedError(undefined, { current: PRIVACY_NOTICE_VERSION });
  }

  const details = {
    first_name: input.first_name,
    last_name: input.last_name,
    email: input.email,
    affiliation_name: input.affiliation_name,
    country: input.country,
  };
  let guest: RegistrationGuest;
  if (account) {
    // Outside the transaction: this may ask auth-cheche for the account's mobile.
    const mobile = await customerAuthService.accountMobile(account, { required: true });
    guest = { account: { userId: account.userId, mobile: mobile as string, person: details } };
  } else {
    if (input.phone === undefined) {
      throw new ValidationAppError("Request validation failed", {
        issues: [{ path: "body.phone", message: "A mobile number is required", code: "required" }],
      });
    }
    guest = { person: { ...details, phone: input.phone } };
  }

  return runTransaction(async (transaction) => {
    const { registration, outcome } = await registrationService.registerOnce(
      {
        organizationId: event.organization_id,
        eventId: event.id,
        ticketTypeCode: input.ticket_type_code,
        guest,
        source: "PUBLIC",
        actorId: null,
        // The notice the form showed, and when: the submission time.
        evidence: { privacyNoticeVersion: input.privacy_notice_version, shownAt: new Date() },
      },
      { scope: "PUBLIC_REGISTRATION", key: idempotencyKey, requestHash: requestHash({ event_id: event.id, body: input, user_id: account?.userId }) },
      transaction,
    );
    const registered = ensureFound(
      await registrationRepository.findDetailsByEventAndId(event.organization_id, event.id, registration.id, { transaction }),
      "Registration not found",
    );
    return { registration: toPublicRegistrationDto(registered, event), replayed: outcome === "REPLAYED", outcome };
  });
}

export const publicRegistrationService = { registerFromPublicForm };
