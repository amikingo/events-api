import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { smsClient } from "../src/clients/sms/index.js";
import { SmsDeliveryError } from "../src/clients/sms/sms-sender.js";
import type { MessageOutboxRow } from "../src/models/message-outbox.js";
import { messageOutboxRepository } from "../src/repositories/message-outbox.repository.js";
import { outboxDeliveryService } from "../src/services/outbox-delivery.service.js";
import { IDS } from "./helpers/fixtures.js";

/** The outbox delivery tick against a mocked repository and SMS client: no database, nothing sent. */
const NOW = new Date("2027-03-01T08:00:00Z");

function message(overrides: Partial<MessageOutboxRow> = {}): MessageOutboxRow {
  return {
    id: "message-1",
    organization_id: IDS.orgA,
    registration_id: IDS.registration,
    kind: "REGISTRATION_CONFIRMATION",
    channel: "SMS",
    recipient: "+251911234567",
    payload: {
      first_name: "Hana",
      organization_name: "Selam Events",
      event_name: "Banking Forum",
      starts_at: "2027-03-12T06:00:00.000Z",
      timezone: "Africa/Addis_Ababa",
      code: "K7M2Q9XP",
    },
    status: "PENDING",
    attempts: 1,
    next_attempt_at: NOW,
    last_error: null,
    sent_at: null,
    provider_message_id: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function arrange(claimed: MessageOutboxRow[], counts: { day?: number; recipient?: number } = {}) {
  return {
    claim: mock.method(messageOutboxRepository, "claimDue", async (_now: Date, _limit: number, _leaseMs: number) => claimed),
    daily: mock.method(messageOutboxRepository, "countSentSince", async () => counts.day ?? 0),
    perPhone: mock.method(messageOutboxRepository, "countSentToRecipientSince", async () => counts.recipient ?? 0),
    sent: mock.method(messageOutboxRepository, "markSent", async (_id: string, _at: Date, _providerId: string | null) => undefined),
    retry: mock.method(messageOutboxRepository, "markForRetry", async (_id: string, _next: Date, _error: string) => undefined),
    final: mock.method(messageOutboxRepository, "markFinal", async (_id: string, _status: string, _reason: string) => undefined),
  };
}

function stubSend(fail = false) {
  return mock.method(smsClient, "send", async (_message: { to: string; text: string }) => {
    if (fail) throw new SmsDeliveryError("AfroMessage 502: upstream down");
    return { providerMessageId: "msg-1" };
  });
}

let send: ReturnType<typeof stubSend>;
beforeEach(() => {
  send = stubSend();
});
afterEach(() => mock.restoreAll());

test("a tick claims due messages with a lease, sends the rendered text, and records SENT", async () => {
  const calls = arrange([message()]);

  const summary = await outboxDeliveryService.processDue(NOW);

  assert.deepEqual(summary, { claimed: 1, sent: 1, retried: 0, failed: 0, skipped: 0 });
  assert.deepEqual(calls.claim.mock.calls[0]?.arguments, [NOW, 20, 5 * 60_000], "20 at a time, 5-minute lease");
  const [sms] = send.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(sms, {
    to: "+251911234567",
    text: "Selam Events: You're registered for Banking Forum, Megabit 3, 2019 at 3:00 in the morning (Mar 12, 2027, 9:00 AM). Your code: K7M2Q9XP",
  });
  const [id, , providerId] = calls.sent.mock.calls[0]?.arguments ?? [];
  assert.deepEqual([id, providerId], ["message-1", "msg-1"]);
});

test("a failure is retried after 1, 5, 15 and 60 minutes; the 5th failure is final", async () => {
  mock.restoreAll();
  send = stubSend(true);
  const expectedDelays = [1, 5, 15, 60];
  for (const [index, minutes] of expectedDelays.entries()) {
    const calls = arrange([message({ attempts: index + 1 })]);
    const summary = await outboxDeliveryService.processDue(NOW);
    assert.equal(summary.retried, 1);
    const [, next, error] = calls.retry.mock.calls[0]?.arguments ?? [];
    assert.equal(next?.getTime(), NOW.getTime() + minutes * 60_000, `attempt ${index + 1}`);
    assert.equal(error, "AfroMessage 502: upstream down");
    mock.restoreAll();
    send = stubSend(true);
  }

  const last = arrange([message({ attempts: 5 })]);
  const summary = await outboxDeliveryService.processDue(NOW);
  assert.equal(summary.failed, 1);
  assert.deepEqual(last.final.mock.calls[0]?.arguments, ["message-1", "FAILED", "AfroMessage 502: upstream down"]);
  assert.equal(last.retry.mock.callCount(), 0);
});

test("more than 5 SMS to one number in an hour, or the daily limit, is SKIPPED without sending", async () => {
  const perPhone = arrange([message()], { recipient: 5 });
  assert.equal((await outboxDeliveryService.processDue(NOW)).skipped, 1);
  assert.equal(perPhone.final.mock.calls[0]?.arguments[1], "SKIPPED");
  const [recipient, since] = perPhone.perPhone.mock.calls[0]?.arguments ?? [];
  assert.deepEqual([recipient, since?.getTime()], ["+251911234567", NOW.getTime() - 60 * 60_000]);
  mock.restoreAll();
  send = stubSend();

  const daily = arrange([message()], { day: 2000 });
  assert.equal((await outboxDeliveryService.processDue(NOW)).skipped, 1);
  assert.match(String(daily.final.mock.calls[0]?.arguments[2]), /Daily SMS limit \(2000\)/);
  assert.equal(send.mock.callCount(), 0);
});

test("nothing claimed means nothing sent", async () => {
  arrange([]);
  assert.deepEqual(await outboxDeliveryService.processDue(NOW), { claimed: 0, sent: 0, retried: 0, failed: 0, skipped: 0 });
  assert.equal(send.mock.callCount(), 0);
});
