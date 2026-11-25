import { smsConfig } from "../../config/sms.js";
import { SmsDeliveryError, type SmsSender } from "./sms-sender.js";

/**
 * Cheche's platform AfroMessage account, the same request as bookings_api's clients/sms.client.js: a GET with the
 * Bearer token, from id, sender, recipient and text. The token stays in the Authorization header and is never put
 * in an error, a log line or the URL.
 */
type AfroMessageReply = { acknowledge?: unknown; response?: { message_id?: unknown; errors?: unknown } | null; message?: unknown };

export type AfroMessageSettings = {
  baseUrl: string;
  token: string | null;
  fromId: string | null;
  sender: string | null;
  timeoutMs: number;
};

function refusalText(reply: AfroMessageReply | null, status: number): string {
  const errors = reply?.response?.errors;
  const first = Array.isArray(errors) ? errors.find((item): item is string => typeof item === "string") : undefined;
  const text = first ?? (typeof reply?.message === "string" ? reply.message : undefined) ?? "AfroMessage refused the message";
  return `AfroMessage ${status}: ${text}`.slice(0, 300);
}

export function createAfroMessageSender(settings: AfroMessageSettings): SmsSender {
  return {
    name: "afromessage",
    async send({ to, text }) {
      const { token, fromId, sender, baseUrl, timeoutMs } = settings;
      if (!token || !fromId || !sender) throw new SmsDeliveryError("AfroMessage is not configured");

      const url = new URL(baseUrl);
      url.search = new URLSearchParams({ from: fromId, sender, to, message: text }).toString();

      let response: Response;
      try {
        response = await fetch(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        throw new SmsDeliveryError(timedOut ? "AfroMessage timed out" : "AfroMessage could not be reached");
      }

      const body = await response.text();
      let reply: AfroMessageReply | null;
      try {
        reply = body ? (JSON.parse(body) as AfroMessageReply) : null;
      } catch {
        throw new SmsDeliveryError(`AfroMessage ${response.status}: not a JSON reply`);
      }
      if (!response.ok || reply?.acknowledge === "error") throw new SmsDeliveryError(refusalText(reply, response.status));

      const messageId = reply?.response?.message_id;
      return { providerMessageId: typeof messageId === "string" || typeof messageId === "number" ? String(messageId) : null };
    },
  };
}

/** The sender for Cheche's platform account, from the environment (see config/sms.ts). */
export const afroMessageSmsSender = createAfroMessageSender({ ...smsConfig.afromessage, timeoutMs: smsConfig.timeoutMs });
