import type {
  EventCancelledPayload,
  EventRescheduledPayload,
  MessageKind,
  MessagePayload,
  OrderConfirmationPayload,
  RegistrationConfirmationPayload,
} from "../models/message-outbox.js";
import { ethiopianClockText, ethiopianDateText, gregorianText, localParts } from "./ethiopian-calendar.js";

/** Keeps a long event name from pushing the message past 2 SMS segments. Plain "..." (an ellipsis character would switch the SMS to a costlier encoding). */
const MAX_EVENT_NAME = 60;

function shortened(name: string): string {
  return name.length <= MAX_EVENT_NAME ? name : `${name.slice(0, MAX_EVENT_NAME - 3).trimEnd()}...`;
}

/**
 * The registration confirmation (decided 25 November 2026: English, Ethiopian date and clock first, then Gregorian
 * with a 12-hour time, in the event's own time zone):
 * "Selam Events: You're registered for Banking Forum, Megabit 3, 2019 at 3:00 in the morning (Mar 12, 2027, 9:00 AM). Your code: K7M2Q9XP"
 */
export function confirmationText(payload: RegistrationConfirmationPayload): string {
  const head = `${payload.organization_name}: You're registered for ${shortened(payload.event_name)}`;
  if (!payload.starts_at) return `${head}. Your code: ${payload.code}`;
  const local = localParts(new Date(payload.starts_at), payload.timezone);
  return `${head}, ${ethiopianDateText(local)} at ${ethiopianClockText(local.hour, local.minute)} (${gregorianText(local)}). Your code: ${payload.code}`;
}

/** The event's date as the confirmation writes it: Ethiopian date and clock, then Gregorian with a 12-hour time. */
function whenText(startsAt: string | null, timezone: string): string | null {
  if (!startsAt) return null;
  const local = localParts(new Date(startsAt), timezone);
  return `${ethiopianDateText(local)} at ${ethiopianClockText(local.hour, local.minute)} (${gregorianText(local)})`;
}

/**
 * The order confirmation (Phase 7): one SMS to the buyer with the order's codes, in the same style as the
 * registration confirmation. An order with many codes is split into parts ("(1/2)"), each listing its codes:
 * "Selam Events: Your 3 tickets for Coffee Festival, Ginbot 24, 2019 at 1:00 in the morning (Jun 1, 2027, 7:00 AM). Codes: K7M2Q9XP, ..."
 */
export function orderConfirmationText(payload: OrderConfirmationPayload): string {
  const count = payload.ticket_count === 1 ? "Your ticket" : `Your ${payload.ticket_count} tickets`;
  const part = payload.parts > 1 ? ` (${payload.part}/${payload.parts})` : "";
  const when = whenText(payload.starts_at, payload.timezone);
  const label = payload.codes.length === 1 ? "Code" : "Codes";
  return `${payload.organization_name}${part}: ${count} for ${shortened(payload.event_name)}${when ? `, ${when}` : ""}. ${label}: ${payload.codes.join(", ")}`;
}

/** The clock time only (Ethiopian, then 12-hour Gregorian), for the door time on the same day as the start. */
function clockText(instant: string, timezone: string): string {
  const local = localParts(new Date(instant), timezone);
  const hour12 = local.hour % 12 === 0 ? 12 : local.hour % 12;
  return `${ethiopianClockText(local.hour, local.minute)} (${hour12}:${String(local.minute).padStart(2, "0")} ${local.hour < 12 ? "AM" : "PM"})`;
}

/** The door time: only the clock when the doors open on the start's day, the whole date otherwise. */
function doorText(doorsOpenAt: string, startsAt: string, timezone: string): string {
  const doors = localParts(new Date(doorsOpenAt), timezone);
  const start = localParts(new Date(startsAt), timezone);
  const sameDay = doors.year === start.year && doors.month === start.month && doors.day === start.day;
  return sameDay ? clockText(doorsOpenAt, timezone) : (whenText(doorsOpenAt, timezone) as string);
}

/**
 * Phase 9: the event is cancelled. The refund line names what is due on the order's unused paid tickets (and used ones
 * only when the organizer approved that); the organizer refunds it through its own merchant account:
 * "Selam Events: Jazz Night, Ginbot 24, 2019 at 1:00 in the morning (Jun 1, 2027, 7:00 AM), is cancelled. A refund of 1000.00 ETB is due to you; the organizer will send it."
 */
export function eventCancelledText(payload: EventCancelledPayload): string {
  const when = whenText(payload.starts_at, payload.timezone);
  const head = `${payload.organization_name}: ${shortened(payload.event_name)}${when ? `, ${when},` : ""} is cancelled.`;
  if (Number(payload.refund_amount) <= 0) return `${head} Please don't pay for it.`;
  return `${head} A refund of ${payload.refund_amount} ${payload.currency} is due to you; the organizer will send it.`;
}

/**
 * Phase 9: the event moved. The new start (and the door time when it differs), in the event's own time zone; the codes
 * stay valid:
 * "Selam Events: Jazz Night has moved to Ginbot 26, 2019 at 1:00 in the morning (Jun 3, 2027, 7:00 AM). Doors open 12:00 in the morning (6:00 AM). Your tickets stay valid. Can't attend? Ask the organizer to return unused tickets."
 */
export function eventRescheduledText(payload: EventRescheduledPayload): string {
  const when = whenText(payload.starts_at, payload.timezone) as string;
  const doors = payload.doors_open_at ? ` Doors open ${doorText(payload.doors_open_at, payload.starts_at, payload.timezone)}.` : "";
  return `${payload.organization_name}: ${shortened(payload.event_name)} has moved to ${when}.${doors} Your tickets stay valid. Can't attend? Ask the organizer to return unused tickets.`;
}

/** The text of a queued message, by its kind. */
export function messageText(kind: MessageKind, payload: MessagePayload): string {
  switch (kind) {
    case "ORDER_CONFIRMATION":
      return orderConfirmationText(payload as OrderConfirmationPayload);
    case "EVENT_CANCELLED":
      return eventCancelledText(payload as EventCancelledPayload);
    case "EVENT_RESCHEDULED":
      return eventRescheduledText(payload as EventRescheduledPayload);
    default:
      return confirmationText(payload as RegistrationConfirmationPayload);
  }
}
