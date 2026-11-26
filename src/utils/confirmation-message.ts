import type { MessageKind, OrderConfirmationPayload, RegistrationConfirmationPayload } from "../models/message-outbox.js";
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

/** The text of a queued message, by its kind. */
export function messageText(kind: MessageKind, payload: RegistrationConfirmationPayload | OrderConfirmationPayload): string {
  return kind === "ORDER_CONFIRMATION" ? orderConfirmationText(payload as OrderConfirmationPayload) : confirmationText(payload as RegistrationConfirmationPayload);
}
