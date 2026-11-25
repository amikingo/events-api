import type { MessageStatus } from "../models/message-outbox.js";
import type { PersonRow } from "../models/person.js";
import type { RegistrationSource, RegistrationStatus } from "../models/registration.js";
import type { TicketTypeRow } from "../models/ticket-type.js";
import type { PublicEventRow } from "../repositories/event.repository.js";
import type { PersonRegistrationRow, RegistrationWithDetails } from "../repositories/registration.repository.js";

/** A guest-list entry for staff: the registration, the guest's contact summary and the ticket type. */
export type RegistrationDto = {
  id: string;
  event_id: string;
  code: string;
  status: RegistrationStatus;
  source: RegistrationSource;
  registered_by: string | null;
  registered_at: Date;
  cancelled_at: Date | null;
  person: { id: string; first_name: string; last_name: string | null; phone: string | null; email: string | null; affiliation_name: string | null };
  ticket_type: { id: string; code: string; name: string };
  /** The privacy notice the public form showed (null for staff entries). */
  privacy_notice: { version: string; shown_at: Date } | null;
  /** The latest confirmation SMS: PENDING, SENT, FAILED or SKIPPED; null when none was queued (no Ethiopian mobile). */
  confirmation: ConfirmationDto;
  created_at: Date;
  updated_at: Date;
};

export type ConfirmationDto = { status: MessageStatus; sent_at: Date | null } | null;

export function toRegistrationDto(row: RegistrationWithDetails, confirmation: ConfirmationDto = null): RegistrationDto {
  return {
    id: row.id,
    event_id: row.event_id,
    code: row.code,
    status: row.status,
    source: row.source,
    registered_by: row.registered_by,
    registered_at: row.registered_at,
    cancelled_at: row.cancelled_at,
    person: {
      id: row.person.id,
      first_name: row.person.first_name,
      last_name: row.person.last_name,
      phone: row.person.phone,
      email: row.person.email,
      affiliation_name: row.person.affiliation_name,
    },
    ticket_type: { id: row.ticketType.id, code: row.ticketType.code, name: row.ticketType.name },
    privacy_notice:
      row.privacy_notice_version !== null && row.privacy_notice_shown_at !== null
        ? { version: row.privacy_notice_version, shown_at: row.privacy_notice_shown_at }
        : null,
    confirmation,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** One of a guest's registrations, shown on their profile so staff can confirm a returning guest. */
export type PersonRegistrationDto = {
  id: string;
  code: string;
  status: RegistrationStatus;
  registered_at: Date;
  cancelled_at: Date | null;
  event: PersonRegistrationRow["event"];
  ticket_type: { id: string; code: string; name: string };
};

export type PersonDetailDto = PersonRow & { registrations: PersonRegistrationDto[] };

export function toPersonDetailDto(person: PersonRow, registrations: PersonRegistrationRow[]): PersonDetailDto {
  return {
    ...person,
    registrations: registrations.map((row) => ({
      id: row.id,
      code: row.code,
      status: row.status,
      registered_at: row.registered_at,
      cancelled_at: row.cancelled_at,
      event: row.event,
      ticket_type: { id: row.ticketType.id, code: row.ticketType.code, name: row.ticketType.name },
    })),
  };
}

/** Places per event and per ticket type. `remaining` is null where there is no limit. */
export type RegistrationSummaryDto = {
  capacity: number | null;
  confirmed: number;
  remaining: number | null;
  ticket_types: Array<{
    id: string;
    code: string;
    name: string;
    is_active: boolean;
    capacity: number | null;
    confirmed: number;
    remaining: number | null;
  }>;
};

const remainingOf = (capacity: number | null, confirmed: number): number | null => (capacity === null ? null : Math.max(0, capacity - confirmed));

export function toRegistrationSummaryDto(
  eventCapacity: number | null,
  ticketTypes: TicketTypeRow[],
  confirmedByTicketType: Map<string, number>,
): RegistrationSummaryDto {
  const rows = ticketTypes.map((ticketType) => {
    const confirmed = confirmedByTicketType.get(ticketType.id) ?? 0;
    return {
      id: ticketType.id,
      code: ticketType.code,
      name: ticketType.name,
      is_active: ticketType.is_active,
      capacity: ticketType.capacity,
      confirmed,
      remaining: remainingOf(ticketType.capacity, confirmed),
    };
  });
  const confirmed = [...confirmedByTicketType.values()].reduce((total, count) => total + count, 0);
  return { capacity: eventCapacity, confirmed, remaining: remainingOf(eventCapacity, confirmed), ticket_types: rows };
}

/** What a visitor sees after registering: their code and the event, never internal ids or other guests' data. */
export type PublicRegistrationDto = {
  code: string;
  status: RegistrationStatus;
  registered_at: Date;
  ticket_type: { code: string; name: string };
  event: { name: string; slug: string; starts_at: Date | null; ends_at: Date | null; timezone: string };
  organization: { name: string; slug: string };
  guest: { first_name: string };
};

export function toPublicRegistrationDto(row: RegistrationWithDetails, event: PublicEventRow): PublicRegistrationDto {
  return {
    code: row.code,
    status: row.status,
    registered_at: row.registered_at,
    ticket_type: { code: row.ticketType.code, name: row.ticketType.name },
    event: { name: event.name, slug: event.slug, starts_at: event.starts_at, ends_at: event.ends_at, timezone: event.timezone },
    organization: { name: event.organization.name, slug: event.organization.slug },
    guest: { first_name: row.person.first_name },
  };
}
