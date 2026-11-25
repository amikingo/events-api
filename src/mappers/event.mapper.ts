import type { EventRow, EventStatus } from "../models/event.js";
import type { TicketTypeRow } from "../models/ticket-type.js";
import type { PublicEventRow } from "../repositories/event.repository.js";

/**
 * Pure response shaping for events, shared by staff (3b) and public (3c) endpoints. No queries, no HTTP.
 * Changing a field here is an API change.
 */
export type EventDisplayStatus = EventStatus | "LIVE";

/** The cover image's public URL path (e.g. /assets/uploads/events/covers/<uuid>.png), or null. */
export type CoverDto = { url: string } | null;

export type EventDto = EventRow & {
  /** LIVE for a published event while starts_at <= now < ends_at; otherwise the stored status. A cancelled event stays CANCELLED. */
  display_status: EventDisplayStatus;
  cover: CoverDto;
};

export function eventDisplayStatus(event: Pick<EventRow, "status" | "starts_at" | "ends_at">, now: Date): EventDisplayStatus {
  if (event.status === "PUBLISHED" && event.starts_at && event.ends_at && event.starts_at <= now && now < event.ends_at) {
    return "LIVE";
  }
  return event.status;
}

export function toEventDto(event: EventRow, now: Date = new Date(), cover: CoverDto = null): EventDto {
  return { ...event, display_status: eventDisplayStatus(event, now), cover };
}

// --- Public (visitor) shapes, Phase 3c --------------------------------------------------------------

/** Why an event is not taking registrations right now (Phase 4 answers it as 409 registration_closed). */
export type RegistrationClosedReason = "NOT_PUBLISHED" | "CANCELLED" | "CLOSED" | "ENDED" | "NOT_OPEN_YET";

type RegistrationTiming = Pick<EventRow, "status" | "ends_at" | "registration_opens_at" | "registration_closes_at">;

/**
 * null while the event takes sign-ups: a PUBLISHED event that has not ended and is inside its registration window.
 * The opening time is inclusive, the closing time exclusive; an unset boundary adds no restriction. CLOSED covers
 * both a closed event and a closed registration window. Capacity is checked separately, by the registration service.
 */
export function registrationClosedReason(event: RegistrationTiming, now: Date): RegistrationClosedReason | null {
  if (event.status === "DRAFT") return "NOT_PUBLISHED";
  if (event.status === "CANCELLED") return "CANCELLED";
  if (event.status === "CLOSED") return "CLOSED";
  if (!event.ends_at || now >= event.ends_at) return "ENDED";
  if (event.registration_opens_at && now < event.registration_opens_at) return "NOT_OPEN_YET";
  if (event.registration_closes_at && now >= event.registration_closes_at) return "CLOSED";
  return null;
}

/** Open for sign-ups (the public `registration_open` flag): see registrationClosedReason. */
export function isRegistrationOpen(event: RegistrationTiming, now: Date): boolean {
  return registrationClosedReason(event, now) === null;
}

/** A catalog card: enough to render and link it (both slugs). No client, staff, internal ids or audit fields. */
export type PublicEventCard = {
  name: string;
  slug: string;
  starts_at: Date | null;
  ends_at: Date | null;
  timezone: string;
  display_status: EventDisplayStatus;
  category: string | null;
  cover: CoverDto;
  registration_open: boolean;
  organization: { name: string; slug: string };
  venue: { name: string; address: string | null; city: string | null; country: string | null } | null;
};

export type PublicEventDetail = PublicEventCard & {
  description: string | null;
  registration_opens_at: Date | null;
  registration_closes_at: Date | null;
  /** Active ticket types only, by code and name. */
  ticket_types: Array<{ code: string; name: string }>;
};

export function toPublicEventCard(event: PublicEventRow, now: Date, cover: CoverDto = null): PublicEventCard {
  return {
    name: event.name,
    slug: event.slug,
    starts_at: event.starts_at,
    ends_at: event.ends_at,
    timezone: event.timezone,
    display_status: eventDisplayStatus(event, now),
    category: event.category,
    cover,
    registration_open: isRegistrationOpen(event, now),
    organization: { name: event.organization.name, slug: event.organization.slug },
    venue: event.venue
      ? { name: event.venue.name, address: event.venue.address, city: event.venue.city, country: event.venue.country }
      : null,
  };
}

export function toPublicEventDetail(
  event: PublicEventRow,
  activeTicketTypes: TicketTypeRow[],
  now: Date,
  cover: CoverDto = null,
): PublicEventDetail {
  return {
    ...toPublicEventCard(event, now, cover),
    description: event.description,
    registration_opens_at: event.registration_opens_at,
    registration_closes_at: event.registration_closes_at,
    ticket_types: activeTicketTypes.map((ticketType) => ({ code: ticketType.code, name: ticketType.name })),
  };
}
