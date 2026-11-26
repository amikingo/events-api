import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { createApp } from "../src/app.js";
import { PRIVACY_NOTICE_VERSION } from "../src/config/privacy.js";
import type { OrderDto, PublicOrderDto } from "../src/mappers/order.mapper.js";
import type { CustomerAuthContext } from "../src/middleware/authentication.js";
import { publicRegistrationLimiter } from "../src/middleware/rate-limit.js";
import { checkoutService } from "../src/services/checkout.service.js";
import { permissionResolutionService, type PermissionScope } from "../src/services/permission-resolution.service.js";
import { chechePayCredentialService } from "../src/services/cheche-pay-credential.service.js";
import { paymentService, type SettleResult } from "../src/services/payment.service.js";
import { publicCheckoutService } from "../src/services/public-checkout.service.js";
import type { PublicOrderInput, StaffOrderInput } from "../src/validators/order.js";
import { centralAccessToken, IDS, staffToken } from "./helpers/fixtures.js";
import { call, withServer, type TestResponse } from "./helpers/http.js";

/** HTTP-level tests of the Phase 7 checkout routes: real auth, validation and envelope; the services are stubbed. */
const app = createApp();
const ordersPath = `/v1/organizations/${IDS.orgA}/events/${IDS.event}/orders`;
const publicPath = "/v1/public/organizations/selam-events/events/coffee-festival/orders";
const KEY = "0b9c1a52-6f1e-4c35-8d2a-2a9f9d3c7e11";
const ITEM = { ticket_type_id: IDS.ticketType, quantity: 2 };
const ORDER = { id: "order-1", reference: "ORDER23456", ticket_count: 2, tickets: [] } as unknown as OrderDto;
const PUBLIC_ORDER = { reference: "ORDER23456", tickets: [{ code: "K7M2Q9XP" }, { code: "M2Q9XPK7" }] } as unknown as PublicOrderDto;
const PUBLIC_FORM = { buyer_mobile: "0913 000 001", privacy_notice_version: PRIVACY_NOTICE_VERSION, items: [{ ticket_type_code: "ga", quantity: 3 }] };

const WEBHOOK_RESULT: SettleResult & { event: string | null } = {
  acknowledged: true,
  processed: true,
  duplicate: false,
  ignored: false,
  review_reason: null,
  provider_status: "SUCCEEDED",
  order_status: "CONFIRMED",
  event: "payment.succeeded",
};

function allowPermissions(allowed: boolean) {
  return mock.method(permissionResolutionService, "resolvePermission", async (input: { scope: PermissionScope }) => ({
    allowed,
    source: allowed ? ("role_permission" as const) : ("default_deny" as const),
    scope: input.scope,
    roleIds: [],
  }));
}

async function postPublic(baseUrl: string, body: unknown, headers: Record<string, string> = { "Idempotency-Key": KEY }): Promise<TestResponse> {
  const response = await fetch(`${baseUrl}${publicPath}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}

beforeEach(() => publicRegistrationLimiter.resetKey("127.0.0.1"));
afterEach(() => mock.restoreAll());

test("staff orders use Guests (REGISTRATIONS) create and view, scoped to the path's organization", async () => {
  const permission = allowPermissions(false);
  await withServer(app, async (baseUrl) => {
    const token = staffToken();
    assert.equal((await call(baseUrl, "POST", ordersPath, { body: { items: [ITEM] } })).status, 401);
    const denied = await call(baseUrl, "POST", ordersPath, { token, body: { items: [ITEM] } });
    assert.deepEqual([denied.status, denied.body.error.code], [403, "permission_denied"]);
    await call(baseUrl, "GET", ordersPath, { token });
    await call(baseUrl, "GET", `${ordersPath}/${IDS.registration}`, { token });
  });
  const asked = permission.mock.calls.map((entry) => {
    const input = entry.arguments[0] as { moduleCode: string; action: string; scope: PermissionScope };
    return [input.moduleCode, input.action, input.scope];
  });
  const organization = { level: "organization", organizationId: IDS.orgA, branchId: null };
  assert.deepEqual(asked, [
    ["REGISTRATIONS", "create", organization],
    ["REGISTRATIONS", "view", organization],
    ["REGISTRATIONS", "view", organization],
  ]);
});

test("a staff order: each ticket type once, whole quantities, no prices; the buyer mobile is normalized; 201, or 200 on a replay", async () => {
  allowPermissions(true);
  let orders = 0;
  const create = mock.method(checkoutService, "createStaffOrder", async (_o: string, _e: string, _body: StaffOrderInput, _actor: string | null, _key?: string) => {
    orders += 1;
    return { order: ORDER, outcome: orders === 1 ? ("CREATED" as const) : ("REPLAYED" as const) };
  });
  await withServer(app, async (baseUrl) => {
    const token = staffToken();
    for (const body of [
      {},
      { items: [] },
      { items: [{ ...ITEM, quantity: 0 }] },
      { items: [{ ...ITEM, quantity: 1.5 }] },
      { items: [ITEM, ITEM] },
      { items: [{ ...ITEM, price: "0" }] },
      { items: [ITEM], total_amount: "0" },
      { items: [ITEM], buyer_mobile: "+44 20 7946 0958" },
      { items: [{ ...ITEM, holders: [{ first_name: "Hana", ticket_code: "X" }] }] },
    ]) {
      assert.equal((await call(baseUrl, "POST", ordersPath, { token, body })).status, 400, JSON.stringify(body));
    }
    const created = await call(baseUrl, "POST", ordersPath, { token, body: { items: [ITEM], buyer_mobile: "0913 000 001" } });
    assert.deepEqual([created.status, created.body.message], [201, "2 tickets issued"]);
    const replay = await call(baseUrl, "POST", ordersPath, { token, body: { items: [ITEM] } });
    assert.deepEqual([replay.status, replay.body.message], [200, "Same request already processed"]);
  });
  const [organizationId, eventId, body, actor] = create.mock.calls[0]?.arguments ?? [];
  assert.deepEqual([organizationId, eventId, body?.buyer_mobile, actor], [IDS.orgA, IDS.event, "+251913000001", IDS.user]);
});

test("the public checkout needs an Idempotency-Key, takes codes upper-cased and an optional guest token; 201 with the codes", async () => {
  const checkout = mock.method(
    publicCheckoutService,
    "checkoutFromPublicForm",
    async (_org: string, _event: string, _key: string, _input: PublicOrderInput, _account?: CustomerAuthContext | null) => ({ order: PUBLIC_ORDER, outcome: "CREATED" as const }),
  );
  await withServer(app, async (baseUrl) => {
    assert.equal((await postPublic(baseUrl, PUBLIC_FORM, {})).status, 400, "no Idempotency-Key");
    for (const body of [
      { ...PUBLIC_FORM, privacy_notice_version: undefined },
      { ...PUBLIC_FORM, items: [{ ticket_type_id: IDS.ticketType, quantity: 1 }] },
      { ...PUBLIC_FORM, items: [{ ticket_type_code: "GA", quantity: 21 }] },
    ]) {
      assert.equal((await postPublic(baseUrl, body)).status, 400, JSON.stringify(body));
    }
    const created = await postPublic(baseUrl, PUBLIC_FORM);
    assert.deepEqual([created.status, created.body.message, created.body.data.tickets.length], [201, "Your tickets are ready", 2]);
    assert.equal((await postPublic(baseUrl, PUBLIC_FORM, { "Idempotency-Key": KEY, Authorization: `Bearer ${centralAccessToken()}` })).status, 201);
    assert.equal((await postPublic(baseUrl, PUBLIC_FORM, { "Idempotency-Key": KEY, Authorization: `Bearer ${staffToken()}` })).status, 401, "a staff token fails");
  });
  const [org, event, key, input, account] = checkout.mock.calls[0]?.arguments ?? [];
  assert.deepEqual([org, event, key, input?.buyer_mobile, input?.items[0]?.ticket_type_code, account], ["selam-events", "coffee-festival", KEY, "+251913000001", "GA", null]);
  assert.ok(checkout.mock.calls[1]?.arguments[4], "the guest's account reaches the service");
});

// --- Phase 7 step 3b: Cheche Pay v2 ----------------------------------------------------------------------

test("the organizer's Cheche Pay keys are platform scope: ORGANIZATIONS view to read, update to save, remove and check", async () => {
  const permission = allowPermissions(false);
  await withServer(app, async (baseUrl) => {
    const token = staffToken();
    const path = `/v1/organizations/${IDS.orgA}/cheche-pay`;
    await call(baseUrl, "GET", path, { token });
    await call(baseUrl, "PUT", path, { token, body: { secret_key: "sk_test_abcd1234" } });
    await call(baseUrl, "DELETE", path, { token });
    await call(baseUrl, "POST", `${path}/check`, { token });
  });
  const asked = permission.mock.calls.map((entry) => {
    const input = entry.arguments[0] as { moduleCode: string; action: string; scope: PermissionScope };
    return [input.moduleCode, input.action, input.scope.level];
  });
  assert.deepEqual(asked, [
    ["ORGANIZATIONS", "view", "platform"],
    ["ORGANIZATIONS", "update", "platform"],
    ["ORGANIZATIONS", "update", "platform"],
    ["ORGANIZATIONS", "update", "platform"],
  ]);
});

test("saving keys: at least one field, nothing unknown; the secret key, a null webhook secret and is_active reach the service", async () => {
  allowPermissions(true);
  const save = mock.method(chechePayCredentialService, "save", async () => ({}) as never);
  await withServer(app, async (baseUrl) => {
    const token = staffToken();
    const path = `/v1/organizations/${IDS.orgA}/cheche-pay`;
    for (const body of [{}, { cheche_pay_service: "SELAM" }, { secret_key: "" }, { is_active: "yes" }]) {
      assert.equal((await call(baseUrl, "PUT", path, { token, body })).status, 400, JSON.stringify(body));
    }
    assert.equal((await call(baseUrl, "PUT", path, { token, body: { secret_key: " sk_test_abcd1234 ", webhook_secret: null, is_active: false } })).status, 200);
  });
  assert.deepEqual(save.mock.calls[0]?.arguments.slice(0, 2), [IDS.orgA, { secret_key: "sk_test_abcd1234", webhook_secret: null, is_active: false }]);
});

test("the buyer's order page and payment check need the order token in X-Order-Token", async () => {
  const read = mock.method(publicCheckoutService, "getOrder", async () => PUBLIC_ORDER);
  const check = mock.method(publicCheckoutService, "checkPayment", async () => PUBLIC_ORDER);
  await withServer(app, async (baseUrl) => {
    // References use the code alphabet (no O, 0, I, 1 or L).
    assert.equal((await fetch(`${baseUrl}/v1/public/orders/ABCDE23456`)).status, 400, "no token");
    assert.equal((await fetch(`${baseUrl}/v1/public/orders/ABCDE23456`, { headers: { "X-Order-Token": "t".repeat(43) } })).status, 200);
    assert.equal((await fetch(`${baseUrl}/v1/public/orders/order-23456`, { headers: { "X-Order-Token": "t".repeat(43) } })).status, 400, "a malformed reference");
    assert.equal((await fetch(`${baseUrl}/v1/public/orders/ABCDE23456/check`, { method: "POST" })).status, 400, "no token");
    assert.equal((await fetch(`${baseUrl}/v1/public/orders/ABCDE23456/check`, { method: "POST", headers: { "X-Order-Token": "t".repeat(43) } })).status, 200);
  });
  assert.deepEqual(read.mock.calls[0]?.arguments, ["ABCDE23456", "t".repeat(43)]);
  assert.deepEqual(check.mock.calls[0]?.arguments, ["ABCDE23456", "t".repeat(43)]);
});

test("Cheche Pay's webhook needs no login and reaches the service with the exact raw bytes and the signature header", async () => {
  const webhook = mock.method(paymentService, "handleWebhook", async () => ({ ...WEBHOOK_RESULT }));
  const raw = '{"event":"payment.succeeded",  "data":{"tx_ref":"c0000000-0000-4000-8000-000000000001-mabc123def"}}';
  await withServer(app, async (baseUrl) => {
    const posted = await fetch(`${baseUrl}/v1/payments/cheche/webhook/${IDS.orgA}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Cheche-Signature": "sha256=abc" }, body: raw });
    assert.equal(posted.status, 200);
    const badId = await fetch(`${baseUrl}/v1/payments/cheche/webhook/not-a-uuid`, { method: "POST", headers: { "Content-Type": "application/json" }, body: raw });
    assert.equal(badId.status, 400);
  });
  assert.equal(webhook.mock.callCount(), 1);
  const input = webhook.mock.calls[0]?.arguments[0] as { organizationId: string; rawBody: Buffer; signature: string };
  assert.deepEqual([input.organizationId, input.rawBody.toString("utf8"), input.signature], [IDS.orgA, raw, "sha256=abc"], "the spacing is kept: the signature covers these bytes");
});

test("payment_option_id is gone: sending it is a 400 on the public and staff checkout", async () => {
  allowPermissions(true);
  mock.method(publicCheckoutService, "checkoutFromPublicForm", async () => ({ order: PUBLIC_ORDER, outcome: "CREATED" as const }));
  mock.method(checkoutService, "createStaffOrder", async () => ({ order: ORDER, outcome: "CREATED" as const }));
  await withServer(app, async (baseUrl) => {
    assert.equal((await postPublic(baseUrl, { ...PUBLIC_FORM, payment_option_id: "opt-telebirr" })).status, 400);
    assert.equal((await call(baseUrl, "POST", ordersPath, { token: staffToken(), body: { items: [ITEM], payment_option_id: "opt-telebirr" } })).status, 400);
  });
});
