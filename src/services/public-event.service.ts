import { toPublicEventCard, toPublicEventDetail, type PublicEventCard, type PublicEventDetail } from "../mappers/event.mapper.js";
import { eventRepository } from "../repositories/event.repository.js";
import { ticketTypeRepository } from "../repositories/ticket-type.repository.js";
import { buildPagination } from "../utils/pagination.js";
import type { PublicEventListQuery } from "../validators/public-event.js";
import { ensureFound } from "./helpers.js";

/**
 * Public, no-login reads (spec §5 catalog rules, decisions of 25 November 2026). One `now` per request, so the
 * catalog filter, display_status and registration_open agree with each other.
 */
async function listCatalog(query: PublicEventListQuery): Promise<{ rows: PublicEventCard[]; count: number }> {
  const now = new Date();
  const { limit, offset } = buildPagination(query);
  const { rows, count } = await eventRepository.listPublicCatalog({
    now,
    category: query.category,
    organizationSlug: query.organization,
    limit,
    offset,
  });
  return { rows: rows.map((row) => toPublicEventCard(row, now)), count };
}

async function getPublicEvent(organizationSlug: string, eventSlug: string): Promise<PublicEventDetail> {
  const now = new Date();
  const event = ensureFound(await eventRepository.findPublishedBySlugs(organizationSlug, eventSlug), "Event not found");
  const ticketTypes = await ticketTypeRepository.listActiveByEvent(event.organization_id, event.id);
  return toPublicEventDetail(event, ticketTypes, now);
}

export const publicEventService = { listCatalog, getPublicEvent };
