import { PRIVACY_NOTICE_VERSION } from "../config/privacy.js";
import { PrivacyNoticeOutdatedError } from "../errors/app-errors.js";
import { toPublicRegistrationDto, type PublicRegistrationDto } from "../mappers/registration.mapper.js";
import { eventRepository } from "../repositories/event.repository.js";
import { registrationRepository } from "../repositories/registration.repository.js";
import { requestHash } from "../utils/request-hash.js";
import type { PublicRegistrationInput } from "../validators/public-registration.js";
import { ensureFound, runTransaction } from "./helpers.js";
import { registrationService } from "./registration.service.js";

/**
 * Public registration (Phase 4b, no login): the same registration core as staff entry, behind a required retry key.
 * The event is found by both slugs with the public rules (an active organization, published at least once); the
 * registration rules then decide whether it takes sign-ups. A visitor always gets a new, unlinked guest profile
 * (spec §6): a matching name, phone or email never links two profiles.
 */
async function registerFromPublicForm(
  organizationSlug: string,
  eventSlug: string,
  idempotencyKey: string,
  input: PublicRegistrationInput,
): Promise<{ registration: PublicRegistrationDto; replayed: boolean }> {
  const event = ensureFound(await eventRepository.findPublishedBySlugs(organizationSlug, eventSlug), "Event not found");
  if (input.privacy_notice_version !== PRIVACY_NOTICE_VERSION) {
    throw new PrivacyNoticeOutdatedError(undefined, { current: PRIVACY_NOTICE_VERSION });
  }

  return runTransaction(async (transaction) => {
    const { registration, outcome } = await registrationService.registerOnce(
      {
        organizationId: event.organization_id,
        eventId: event.id,
        ticketTypeCode: input.ticket_type_code,
        guest: {
          person: {
            first_name: input.first_name,
            last_name: input.last_name,
            email: input.email,
            phone: input.phone,
            affiliation_name: input.affiliation_name,
            country: input.country,
          },
        },
        source: "PUBLIC",
        actorId: null,
        // The notice the form showed, and when: the submission time.
        evidence: { privacyNoticeVersion: input.privacy_notice_version, shownAt: new Date() },
      },
      { scope: "PUBLIC_REGISTRATION", key: idempotencyKey, requestHash: requestHash({ event_id: event.id, body: input }) },
      transaction,
    );
    const details = ensureFound(
      await registrationRepository.findDetailsByEventAndId(event.organization_id, event.id, registration.id, { transaction }),
      "Registration not found",
    );
    return { registration: toPublicRegistrationDto(details, event), replayed: outcome === "REPLAYED" };
  });
}

export const publicRegistrationService = { registerFromPublicForm };
