/**
 * The one shape every SMS provider implements, so a provider (Raven later) is one new sender, never a change to the
 * outbox worker. `send` resolves when the provider accepted the message and throws when it did not.
 */
export type SmsMessage = { to: string; text: string };
export type SmsSendResult = { providerMessageId: string | null };

export type SmsSender = {
  readonly name: string;
  send(message: SmsMessage): Promise<SmsSendResult>;
};

/** A provider refusal or outage. The message is safe to store and log: it never contains a token. */
export class SmsDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmsDeliveryError";
  }
}

/** "+251911234567" → "+2519****4567": enough to recognize a number in logs without exposing it. */
export function maskPhone(phone: string): string {
  if (phone.length <= 8) return "****";
  return `${phone.slice(0, 5)}****${phone.slice(-4)}`;
}
