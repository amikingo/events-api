import { PRIVACY_NOTICE_VERSION } from "../config/privacy.js";
import type { EventRow, EventStatus } from "../models/event.js";
import type { TicketTypeRow } from "../models/ticket-type.js";
import { isZeroAmount } from "../utils/money.js";
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
export type RegistrationClosedReason = "NOT_PUBLISHED" | "CANCELLED" | "CLOSED" | "ENDED" | "NOT_OPEN_YET" | "NO_PUBLIC_TICKETS";

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

/**
 * Open for public sign-ups (the public `registration_open` flag): see registrationClosedReason. Since Phase 7 the
 * event also needs an active PUBLIC ticket type: staff-only types never make an event look open to the public.
 * `hasPublicTickets` undefined means the caller didn't load it (counts as yes).
 */
export function isRegistrationOpen(event: RegistrationTiming, now: Date, hasPublicTickets?: boolean): boolean {
  return registrationClosedReason(event, now) === null && hasPublicTickets !== false;
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
  /** Phase 9: when the doors open; null means at starts_at. */
  doors_open_at: Date | null;
  /** Active PUBLIC ticket types only, in display order. Since Phase 7 with the price ("0.00" is free) and currency. */
  ticket_types: PublicTicketTypeDto[];
  /** Phase 7: QUICK (one buyer mobile; tickets may be unnamed) or DETAILED (each holder's details). */
  registration_mode: EventRow["registration_mode"];
  /** Phase 7: for DETAILED events, how each holder detail is asked for (REQUIRED, OPTIONAL or HIDDEN). */
  holder_fields: EventRow["holder_fields"];
  /** Phase 7: most tickets one buyer mobile may hold at this event; null means no limit. */
  purchase_limit_per_mobile: number | null;
  /** The privacy notice the registration form must show; the form sends this version back (Phase 4b). */
  privacy_notice: { version: string };
};

export type PublicTicketTypeDto = { code: string; name: string; price: string; currency: string; is_free: boolean };

export function toPublicTicketTypeDto(ticketType: TicketTypeRow): PublicTicketTypeDto {
  return { code: ticketType.code, name: ticketType.name, price: ticketType.price, currency: ticketType.currency, is_free: isZeroAmount(ticketType.price) };
}

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
    registration_open: isRegistrationOpen(event, now, event.has_public_tickets),
    organization: { name: event.organization.name, slug: event.organization.slug },
    venue: event.venue
      ? { name: event.venue.name, address: event.venue.address, city: event.venue.city, country: event.venue.country }
      : null,
  };
}

/** `activeTicketTypes`: the event's active ticket types; only PUBLIC ones are shown or count towards being open. */
export function toPublicEventDetail(
  event: PublicEventRow,
  activeTicketTypes: TicketTypeRow[],
  now: Date,
  cover: CoverDto = null,
): PublicEventDetail {
  const publicTypes = activeTicketTypes.filter((ticketType) => ticketType.audience === "PUBLIC");
  return {
    ...toPublicEventCard({ ...event, has_public_tickets: publicTypes.length > 0 }, now, cover),
    description: event.description,
    registration_opens_at: event.registration_opens_at,
    registration_closes_at: event.registration_closes_at,
    doors_open_at: event.doors_open_at,
    ticket_types: publicTypes.map(toPublicTicketTypeDto),
    registration_mode: event.registration_mode,
    holder_fields: event.holder_fields,
    purchase_limit_per_mobile: event.purchase_limit_per_mobile,
    privacy_notice: { version: PRIVACY_NOTICE_VERSION },
  };
}
