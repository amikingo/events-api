import type { EventRow, EventStatus } from "../models/event.js";

/**
 * Pure response shaping for events, shared by staff (3b) and public (3c) endpoints. No queries, no HTTP.
 * Changing a field here is an API change.
 */
export type EventDisplayStatus = EventStatus | "LIVE";

export type EventDto = EventRow & {
  /** LIVE for a published event while starts_at <= now < ends_at; otherwise the stored status. A cancelled event stays CANCELLED. */
  display_status: EventDisplayStatus;
};

export function eventDisplayStatus(event: Pick<EventRow, "status" | "starts_at" | "ends_at">, now: Date): EventDisplayStatus {
  if (event.status === "PUBLISHED" && event.starts_at && event.ends_at && event.starts_at <= now && now < event.ends_at) {
    return "LIVE";
  }
  return event.status;
}

export function toEventDto(event: EventRow, now: Date = new Date()): EventDto {
  return { ...event, display_status: eventDisplayStatus(event, now) };
}
