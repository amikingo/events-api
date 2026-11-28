import { fileStorageClient } from "../clients/file-storage.client.js";
import {
  toPublicEventCard,
  toPublicEventDetail,
  type CoverDto,
  type PublicEventCard,
  type PublicEventDetail,
} from "../mappers/event.mapper.js";
import { eventRepository, type PublicEventRow } from "../repositories/event.repository.js";
import { ticketTypeRepository } from "../repositories/ticket-type.repository.js";
import { ticketing } from "./ticketing.js";
import { buildPagination } from "../utils/pagination.js";
import type { PublicEventListQuery } from "../validators/public-event.js";
import { ensureFound } from "./helpers.js";

/**
 * Public, no-login reads (spec §5 catalog rules, decisions of 25 November 2026). One `now` per request, so the
 * catalog filter, display_status and registration_open agree with each other.
 */
function coverOf(event: PublicEventRow): CoverDto {
  return event.coverFile ? { url: fileStorageClient.url(event.coverFile.storage_key) } : null;
}

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
  // The cards show prices: one query for the page's ticket types and one for their price windows.
  const ticketTypes = await ticketTypeRepository.listActivePublicByEvents(rows);
  const quotes = await ticketing.quotePricesAcrossEvents(ticketTypes, now);
  const cards = rows.map((row) =>
    toPublicEventCard(row, now, coverOf(row), ticketTypes.filter((type) => type.organization_id === row.organization_id && type.event_id === row.id), quotes),
  );
  return { rows: cards, count };
}

async function getPublicEvent(organizationSlug: string, eventSlug: string): Promise<PublicEventDetail> {
  const now = new Date();
  const event = ensureFound(await eventRepository.findPublishedBySlugs(organizationSlug, eventSlug), "Event not found");
  const ticketTypes = await ticketTypeRepository.listActiveByEvent(event.organization_id, event.id);
  // Phase 11: the same resolver checkout uses, at this instant.
  const quotes = await ticketing.quotePrices(event.organization_id, event.id, ticketTypes, now);
  return toPublicEventDetail(event, ticketTypes, now, coverOf(event), quotes);
}

export const publicEventService = { listCatalog, getPublicEvent };
