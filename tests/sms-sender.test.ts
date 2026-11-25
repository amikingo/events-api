import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { createAfroMessageSender } from "../src/clients/sms/afromessage.sender.js";
import { maskPhone, SmsDeliveryError } from "../src/clients/sms/sms-sender.js";

/** The AfroMessage sender against a fake fetch: the request shape, refusals, and the token staying secret. */
const TOKEN = "afro-test-token-never-logged";
const sender = createAfroMessageSender({
  baseUrl: "https://api.afromessage.com/api/send",
  token: TOKEN,
  fromId: "from-id-1",
  sender: "CHECHE",
  timeoutMs: 1000,
});
const MESSAGE = { to: "+251911234567", text: "Selam Events: You're registered. Your code: K7M2Q9XP" };

function fakeFetch(status: number, body: string) {
  return mock.method(globalThis, "fetch", async (_url: URL | string, _init?: RequestInit) => new Response(body, { status }));
}

afterEach(() => mock.restoreAll());

test("a send is a GET with from, sender, to and message, and the token only in the Authorization header", async () => {
  const calls = fakeFetch(200, JSON.stringify({ acknowledge: "success", response: { message_id: "msg-42" } }));

  assert.deepEqual(await sender.send(MESSAGE), { providerMessageId: "msg-42" });

  const [url, init] = calls.mock.calls[0]?.arguments ?? [];
  const href = url instanceof URL ? url.href : typeof url === "string" ? url : (url?.url ?? "");
  const sent = new URL(href);
  assert.equal(`${sent.origin}${sent.pathname}`, "https://api.afromessage.com/api/send");
  assert.deepEqual(Object.fromEntries(sent.searchParams), { from: "from-id-1", sender: "CHECHE", to: "+251911234567", message: MESSAGE.text });
  assert.ok(!href.includes(TOKEN), "never in the URL");
  assert.equal(init?.method, "GET");
  assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
});

test("acknowledge error, a non-2xx reply or a non-JSON reply is a failure whose text never contains the token", async () => {
  const cases: Array<[number, string, RegExp]> = [
    [200, JSON.stringify({ acknowledge: "error", response: { errors: ["Invalid phone number"] } }), /Invalid phone number/],
    [401, JSON.stringify({ message: "Unauthorized" }), /AfroMessage 401: Unauthorized/],
    [502, "<html>Bad gateway</html>", /not a JSON reply/],
  ];
  for (const [status, body, expected] of cases) {
    fakeFetch(status, body);
    await assert.rejects(sender.send(MESSAGE), (error: unknown) => {
      assert.ok(error instanceof SmsDeliveryError);
      assert.match(error.message, expected);
      assert.ok(!error.message.includes(TOKEN));
      return true;
    });
    mock.restoreAll();
  }
});

test("a network failure or timeout is a failure; a sender without settings refuses to send", async () => {
  mock.method(globalThis, "fetch", async () => {
    throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  });
  await assert.rejects(sender.send(MESSAGE), /AfroMessage timed out/);
  mock.restoreAll();

  const unconfigured = createAfroMessageSender({ baseUrl: "https://api.afromessage.com/api/send", token: null, fromId: null, sender: null, timeoutMs: 1000 });
  const calls = fakeFetch(200, "{}");
  await assert.rejects(unconfigured.send(MESSAGE), /not configured/);
  assert.equal(calls.mock.callCount(), 0);
});

test("phones are masked in logs", () => {
  assert.equal(maskPhone("+251911234567"), "+2519****4567");
  assert.equal(maskPhone("123"), "****");
});
