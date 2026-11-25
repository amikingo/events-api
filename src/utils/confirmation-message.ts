import type { RegistrationConfirmationPayload } from "../models/message-outbox.js";
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
