import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { Transaction } from "sequelize";
import {
  CapacityReachedError,
  ConflictError,
  IdempotencyKeyReusedError,
  NotFoundError,
  PaidSalesUnavailableError,
  PurchaseLimitReachedError,
  RegistrationClosedError,
  ValidationAppError,
} from "../src/errors/app-errors.js";
import type { EventRow } from "../src/models/event.js";
import type { MessageOutboxRow, OrderConfirmationPayload } from "../src/models/message-outbox.js";
import type { OrderPaymentRow } from "../src/models/order-payment.js";
import type { PersonRow } from "../src/models/person.js";
import type { RegistrationRow } from "../src/models/registration.js";
import type { TicketOrderRow } from "../src/models/ticket-order.js";
import type { TicketTypeRow } from "../src/models/ticket-type.js";
import { eventRepository } from "../src/repositories/event.repository.js";
import { messageOutboxRepository } from "../src/repositories/message-outbox.repository.js";
import { orderPaymentRepository } from "../src/repositories/order-payment.repository.js";
import { organizationRepository } from "../src/repositories/organization.repository.js";
import { personRepository } from "../src/repositories/person.repository.js";
import { registrationRepository } from "../src/repositories/registration.repository.js";
import { submissionKeyRepository } from "../src/repositories/submission-key.repository.js";
import { ticketOrderRepository } from "../src/repositories/ticket-order.repository.js";
import { ticketTypeRepository } from "../src/repositories/ticket-type.repository.js";
import { checkoutService, type CheckoutInput } from "../src/services/checkout.service.js";
import { transactionManager } from "../src/services/helpers.js";
import { eventRow, IDS, orderRow, organizationRow, personRow, registrationRow, ticketTypeRow } from "./helpers/fixtures.js";

/** The checkout core (Phase 7 step 2) against mocked repositories and a fake transaction: no database needed. */
const FAKE_TX = { id: "fake-transaction" } as unknown as Transaction;
const PUBLISHED = { status: "PUBLISHED" as const, published_at: new Date("2026-11-01T00:00:00Z") };
const GA = ticketTypeRow({ id: "b0000000-0000-4000-8000-000000000002", code: "GA" });
const VIP = ticketTypeRow({ id: "b0000000-0000-4000-8000-000000000001", code: "VIP", name: "VIP" });
const CREW = ticketTypeRow({ id: "b0000000-0000-4000-8000-000000000003", code: "CREW", audience: "STAFF_ONLY" });
const HANA = "+251913000001";

type Arrange = { event?: EventRow; ticketTypes?: TicketTypeRow[]; eventTaken?: number; typeTaken?: number; buyerHeld?: number };

function arrange(options: Arrange = {}) {
  const calls: string[] = [];
  const event = options.event ?? eventRow({ ...PUBLISHED, registration_mode: "QUICK" });
  const types = options.ticketTypes ?? [GA, VIP, CREW];
  let codes = 0;
  return {
    calls,
    findEvent: mock.method(eventRepository, "findByOrganizationAndId", async (_o: string, _e: string, repo?: { lock?: boolean }) => {
      calls.push(repo?.lock ? "event:lock" : "event");
      return event;
    }),
    findType: mock.method(ticketTypeRepository, "findByEventAndId", async (_o: string, _e: string, id: string, repo?: { lock?: boolean }) => {
      if (repo?.lock) calls.push(`type:${id}`);
      return types.find((type) => type.id === id) ?? null;
    }),
    findTypeByCode: mock.method(ticketTypeRepository, "findByEventAndCode", async (_o: string, _e: string, code: string) => types.find((type) => type.code === code) ?? null),
    countEvent: mock.method(registrationRepository, "countConfirmedByEvent", async () => options.eventTaken ?? 0),
    countType: mock.method(registrationRepository, "countConfirmedByTicketType", async () => options.typeTaken ?? 0),
    countBuyer: mock.method(registrationRepository, "countConfirmedByBuyerMobile", async () => options.buyerHeld ?? 0),
    referenceExists: mock.method(ticketOrderRepository, "referenceExists", async () => false),
    codeExists: mock.method(registrationRepository, "codeExists", async () => false),
    createOrder: mock.method(ticketOrderRepository, "create", async (values: Partial<TicketOrderRow>, _o?: unknown) => {
      calls.push("order");
      return orderRow({ ...values, id: "order-1" });
    }),
    createPerson: mock.method(personRepository, "create", async (values: Partial<PersonRow>, _o?: unknown) => personRow({ ...values, id: `person-${values.first_name}` })),
    createTicket: mock.method(registrationRepository, "create", async (values: Partial<RegistrationRow>, _o?: unknown) => {
      codes += 1;
      return registrationRow({ ...values, id: `ticket-${codes}` });
    }),
    findOrganization: mock.method(organizationRepository, "findById", async () => organizationRow({ name: "Selam Events" })),
    queue: mock.method(messageOutboxRepository, "create", async (_values: Partial<MessageOutboxRow>, _o?: unknown) => ({}) as never),
    expiredHolds: mock.method(ticketOrderRepository, "listExpiredPendingByEvent", async () => []),
  };
}

const quick = (items: CheckoutInput["items"], extra: Partial<CheckoutInput> = {}): CheckoutInput => ({
  organizationId: IDS.orgA,
  eventId: IDS.event,
  source: "PUBLIC",
  actorId: null,
  buyer: { mobile: HANA, userId: null },
  items,
  accessTokenHash: null,
  ...extra,
});

beforeEach(() => {
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
});
afterEach(() => mock.restoreAll());

const issuesOf = (error: unknown) => (error as { details: { issues: Array<{ path: string; code: string }> } }).details.issues.map((issue) => [issue.path, issue.code]);

test("a quick order: one order, one unnamed ticket per unit with its own code and price, one SMS to the buyer; event locked, then types by id", async () => {
  const calls = arrange();
  const { order, tickets } = await checkoutService.checkoutInTransaction(
    quick([
      { ticketTypeCode: "GA", quantity: 2 },
      { ticketTypeCode: "VIP", quantity: 1 },
    ]),
    FAKE_TX,
  );

  assert.deepEqual(calls.calls.slice(0, 3), ["event:lock", `type:${VIP.id}`, `type:${GA.id}`], "the event first, then the ticket types in id order");
  const [orderValues] = calls.createOrder.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(
    [orderValues?.source, orderValues?.status, orderValues?.buyer_mobile, orderValues?.total_amount, orderValues?.currency],
    ["PUBLIC", "CONFIRMED", HANA, "0.00", "ETB"],
  );
  assert.equal(order.id, "order-1");
  assert.equal(tickets.length, 3);
  assert.deepEqual(
    calls.createTicket.mock.calls.map((call) => [call.arguments[0].ticket_type_id, call.arguments[0].person_id, call.arguments[0].order_id, call.arguments[0].price_amount]),
    [
      [GA.id, null, "order-1", "0.00"],
      [GA.id, null, "order-1", "0.00"],
      [VIP.id, null, "order-1", "0.00"],
    ],
  );
  assert.equal(new Set(calls.createTicket.mock.calls.map((call) => call.arguments[0].code)).size, 3, "three distinct codes");
  assert.equal(calls.createPerson.mock.callCount(), 0, "quick tickets make no profiles");

  assert.equal(calls.queue.mock.callCount(), 1);
  const [message] = calls.queue.mock.calls[0]?.arguments ?? [];
  assert.deepEqual([message?.kind, message?.recipient, message?.order_id, message?.registration_id], ["ORDER_CONFIRMATION", HANA, "order-1", null]);
  assert.equal((message?.payload as OrderConfirmationPayload).codes.length, 3);
});

test("more than 10 codes are sent as several SMS; more than 20 tickets is refused", async () => {
  const calls = arrange();
  await checkoutService.checkoutInTransaction(quick([{ ticketTypeCode: "GA", quantity: 12 }]), FAKE_TX);
  const payloads = calls.queue.mock.calls.map((call) => call.arguments[0].payload as OrderConfirmationPayload);
  assert.deepEqual(payloads.map((payload) => [payload.part, payload.parts, payload.codes.length, payload.ticket_count]), [
    [1, 2, 10, 12],
    [2, 2, 2, 12],
  ]);

  await assert.rejects(
    checkoutService.checkoutInTransaction(quick([{ ticketTypeCode: "GA", quantity: 20 }, { ticketTypeCode: "VIP", quantity: 1 }]), FAKE_TX),
    (error: unknown) => error instanceof ValidationAppError && JSON.stringify(issuesOf(error)) === JSON.stringify([["body.items", "too_many_tickets"]]),
  );
});

test("a detailed order needs one holder per ticket, following the event's holder fields, and makes a profile for each", async () => {
  const event = eventRow({ ...PUBLISHED, holder_fields: { name: "REQUIRED", mobile: "OPTIONAL", email: "OPTIONAL", affiliation: "REQUIRED", country: "HIDDEN" } });
  const calls = arrange({ event });

  await assert.rejects(checkoutService.checkoutInTransaction(quick([{ ticketTypeCode: "GA", quantity: 2, holders: [{ first_name: "Hana", affiliation_name: "Bank" }] }]), FAKE_TX), (error: unknown) => {
    assert.deepEqual(issuesOf(error), [["body.items.0.holders", "holders_count"]]);
    return true;
  });
  await assert.rejects(
    checkoutService.checkoutInTransaction(
      quick([{ ticketTypeCode: "GA", quantity: 3, holders: [{ first_name: "Hana", affiliation_name: "Bank" }, { first_name: "Abel" }, { first_name: "Liya", affiliation_name: "NGO", country: "ET" }] }]),
      FAKE_TX,
    ),
    (error: unknown) => {
      assert.deepEqual(issuesOf(error), [
        ["body.items.0.holders.1.affiliation_name", "required"],
        ["body.items.0.holders.2.country", "not_collected"],
      ]);
      return true;
    },
  );
  assert.equal(calls.createOrder.mock.callCount(), 0, "a refused order writes nothing and takes no place");

  await checkoutService.checkoutInTransaction(
    quick([{ ticketTypeCode: "GA", quantity: 2, holders: [{ first_name: "Hana", affiliation_name: "Bank" }, { first_name: "Abel", affiliation_name: "NGO" }] }]),
    FAKE_TX,
  );
  assert.deepEqual(calls.createPerson.mock.calls.map((call) => [call.arguments[0].first_name, call.arguments[0].affiliation_name, call.arguments[0].user_id]), [
    ["Hana", "Bank", null],
    ["Abel", "NGO", null],
  ]);
  assert.deepEqual(calls.createTicket.mock.calls.map((call) => call.arguments[0].person_id), ["person-Hana", "person-Abel"]);
});

test("a quick event takes no holder details", async () => {
  arrange();
  await assert.rejects(checkoutService.checkoutInTransaction(quick([{ ticketTypeCode: "GA", quantity: 1, holders: [{ first_name: "Hana" }] }]), FAKE_TX), (error: unknown) => {
    assert.deepEqual(issuesOf(error), [["body.items.0.holders", "not_collected"]]);
    return true;
  });
});

test("a staff-only type is not found for the public, even by code; staff may order it", async () => {
  const calls = arrange();
  await assert.rejects(checkoutService.checkoutInTransaction(quick([{ ticketTypeCode: "CREW", quantity: 1 }]), FAKE_TX), NotFoundError);
  await checkoutService.checkoutInTransaction(quick([{ ticketTypeId: CREW.id, quantity: 1 }], { source: "STAFF", actorId: IDS.user }), FAKE_TX);
  assert.equal(calls.createTicket.mock.calls[0]?.arguments[0].registered_by, IDS.user);
});

test("the whole order must fit: event capacity and each type's limit; nothing is written otherwise", async () => {
  const event = arrange({ event: eventRow({ ...PUBLISHED, registration_mode: "QUICK", capacity: 10 }), eventTaken: 8 });
  await assert.rejects(
    checkoutService.checkoutInTransaction(quick([{ ticketTypeCode: "GA", quantity: 3 }]), FAKE_TX),
    (error: unknown) => error instanceof CapacityReachedError && JSON.stringify(error.details) === JSON.stringify({ scope: "EVENT", capacity: 10, remaining: 2 }),
  );
  assert.equal(event.createOrder.mock.callCount(), 0);
  mock.restoreAll();
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));

  arrange({ ticketTypes: [ticketTypeRow({ ...VIP, capacity: 5 })], typeTaken: 4 });
  await assert.rejects(
    checkoutService.checkoutInTransaction(quick([{ ticketTypeCode: "VIP", quantity: 2 }]), FAKE_TX),
    (error: unknown) => error instanceof CapacityReachedError && (error.details as { scope: string; remaining: number }).remaining === 1,
  );
});

test("the purchase limit combines what the buyer mobile already holds with this order", async () => {
  const calls = arrange({ event: eventRow({ ...PUBLISHED, registration_mode: "QUICK", purchase_limit_per_mobile: 4 }), buyerHeld: 3 });
  await assert.rejects(
    checkoutService.checkoutInTransaction(quick([{ ticketTypeCode: "GA", quantity: 2 }]), FAKE_TX),
    (error: unknown) => error instanceof PurchaseLimitReachedError && JSON.stringify(error.details) === JSON.stringify({ limit: 4, held: 3, requested: 2 }),
  );
  await checkoutService.checkoutInTransaction(quick([{ ticketTypeCode: "GA", quantity: 1 }]), FAKE_TX);
  assert.deepEqual(calls.countBuyer.mock.calls[0]?.arguments.slice(0, 3), [IDS.orgA, IDS.event, HANA]);
  assert.equal(calls.createOrder.mock.callCount(), 1);
});

const PAID_TYPES = [ticketTypeRow({ ...GA, price: "500.00" }), ticketTypeRow({ ...VIP, price: "1000.00" })];
const TELEBIRR = { optionId: "opt-telebirr", serviceCode: "SELAM" };

test("a paid order needs the organizer's Cheche Pay service code, ETB and a chosen option; a closed event is refused first", async () => {
  const calls = arrange({ ticketTypes: PAID_TYPES });
  const organization = mock.method(organizationRepository, "findById", async () => organizationRow({ cheche_pay_service: null }));
  await assert.rejects(
    checkoutService.checkoutInTransaction(quick([{ ticketTypeCode: "GA", quantity: 1 }], { payment: TELEBIRR }), FAKE_TX),
    (error: unknown) => error instanceof PaidSalesUnavailableError && (error.details as { reason: string }).reason === "NO_CHECHE_PAY_SERVICE",
  );
  organization.mock.mockImplementation(async () => organizationRow({ cheche_pay_service: "SELAM" }));
  await assert.rejects(checkoutService.checkoutInTransaction(quick([{ ticketTypeCode: "GA", quantity: 1 }]), FAKE_TX), (error: unknown) => {
    assert.deepEqual(issuesOf(error), [["body.payment_option_id", "required"]]);
    return true;
  });
  await assert.rejects(
    checkoutService.checkoutInTransaction(quick([{ ticketTypeCode: "GA", quantity: 1 }], { payment: { ...TELEBIRR, serviceCode: "OLD" } }), FAKE_TX),
    ConflictError,
    "the organizer's code changed since the option was checked",
  );
  assert.equal(calls.createOrder.mock.callCount(), 0);
  mock.restoreAll();
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));

  arrange({ ticketTypes: [ticketTypeRow({ ...GA, price: "20.00", currency: "USD" })] });
  mock.method(organizationRepository, "findById", async () => organizationRow({ cheche_pay_service: "SELAM" }));
  await assert.rejects(
    checkoutService.checkoutInTransaction(quick([{ ticketTypeCode: "GA", quantity: 1 }], { payment: TELEBIRR }), FAKE_TX),
    (error: unknown) => error instanceof PaidSalesUnavailableError && (error.details as { reason: string }).reason === "CURRENCY",
  );
  mock.restoreAll();
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));

  arrange({ event: eventRow({ status: "DRAFT" }) });
  await assert.rejects(checkoutService.checkoutInTransaction(quick([{ ticketTypeCode: "GA", quantity: 1 }]), FAKE_TX), RegistrationClosedError);
});

test("a paid order: prices from the server, every place held without a code until the hold expires, one Cheche Pay payment for the chosen option, no SMS yet", async () => {
  const calls = arrange({ ticketTypes: PAID_TYPES });
  mock.method(organizationRepository, "findById", async () => organizationRow({ name: "Selam Events", cheche_pay_service: "SELAM" }));
  const createPayment = mock.method(orderPaymentRepository, "create", async (values: Partial<OrderPaymentRow>) => ({ ...values, id: "payment-1" }) as OrderPaymentRow);

  const before = Date.now();
  const { order, payment } = await checkoutService.checkoutInTransaction(
    quick([{ ticketTypeCode: "GA", quantity: 2 }, { ticketTypeCode: "VIP", quantity: 1 }], { accessTokenHash: "a".repeat(64), payment: TELEBIRR }),
    FAKE_TX,
  );

  const [orderValues] = calls.createOrder.mock.calls[0]?.arguments ?? [];
  assert.deepEqual([orderValues?.status, orderValues?.total_amount, orderValues?.currency, orderValues?.access_token_hash], ["PENDING_PAYMENT", "2000.00", "ETB", "a".repeat(64)]);
  const holdMinutes = ((orderValues?.hold_expires_at as Date).getTime() - before) / 60_000;
  assert.ok(holdMinutes > 14 && holdMinutes <= 15.1, `held for the configured 15 minutes (${holdMinutes})`);
  assert.deepEqual(
    calls.createTicket.mock.calls.map((call) => [call.arguments[0].status, call.arguments[0].code, call.arguments[0].price_amount]),
    [
      ["HELD", null, "500.00"],
      ["HELD", null, "500.00"],
      ["HELD", null, "1000.00"],
    ],
  );
  const [paymentValues] = createPayment.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(
    [paymentValues?.payment_option_id, paymentValues?.cheche_pay_service, paymentValues?.amount, paymentValues?.currency, paymentValues?.status],
    ["opt-telebirr", "SELAM", "2000.00", "ETB", "INITIATED"],
  );
  assert.equal(order.status, "PENDING_PAYMENT");
  assert.equal(payment?.id, "payment-1");
  assert.equal(calls.queue.mock.callCount(), 0, "the SMS comes with Cheche Pay's Completed callback");
});

test("a paid order needs a buyer mobile (staff may leave it out of a free order only)", async () => {
  arrange({ ticketTypes: [ticketTypeRow({ ...GA, price: "500.00" })] });
  mock.method(organizationRepository, "findById", async () => organizationRow({ cheche_pay_service: "SELAM" }));
  await assert.rejects(
    checkoutService.checkoutInTransaction(
      quick([{ ticketTypeId: GA.id, quantity: 1 }], { source: "STAFF", actorId: IDS.user, buyer: { mobile: null, userId: null }, payment: TELEBIRR }),
      FAKE_TX,
    ),
    (error: unknown) => JSON.stringify(issuesOf(error)) === JSON.stringify([["body.buyer_mobile", "required"]]),
  );
});

test("expired holds of the event are released before anything is counted", async () => {
  const calls = arrange({ event: eventRow({ ...PUBLISHED, registration_mode: "QUICK", capacity: 1 }) });
  calls.expiredHolds.mock.mockImplementation(async () => [orderRow({ id: "stale-order", status: "PENDING_PAYMENT" })]);
  const release = mock.method(registrationRepository, "releaseHeldByOrder", async () => 1);
  const expire = mock.method(ticketOrderRepository, "updateById", async () => undefined);
  await checkoutService.checkoutInTransaction(quick([{ ticketTypeCode: "GA", quantity: 1 }]), FAKE_TX);
  assert.equal(release.mock.calls[0]?.arguments[2], "stale-order");
  assert.deepEqual(expire.mock.calls[0]?.arguments.slice(1, 3), ["stale-order", { status: "EXPIRED" }]);
});

test("a retry key: the same request returns the original order; another request with the key is refused; a new key stores the order", async () => {
  const calls = arrange();
  const store = mock.method(submissionKeyRepository, "create", async () => ({}) as never);
  const findKey = mock.method(submissionKeyRepository, "findByScopeAndKey", async () => null);
  const submission = { scope: "PUBLIC_CHECKOUT" as const, key: "key-0000-0001", requestHash: "a".repeat(64) };

  const first = await checkoutService.checkoutOnce(quick([{ ticketTypeCode: "GA", quantity: 3 }]), submission, FAKE_TX);
  assert.equal(first.outcome, "CREATED");
  assert.deepEqual(
    (store.mock.calls[0]?.arguments as unknown as [Record<string, unknown>])[0],
    { organization_id: IDS.orgA, scope: "PUBLIC_CHECKOUT", key: submission.key, request_hash: submission.requestHash, registration_id: null, order_id: "order-1" },
  );

  findKey.mock.mockImplementation(async () => ({ id: "k", organization_id: IDS.orgA, scope: "PUBLIC_CHECKOUT" as const, key: submission.key, request_hash: submission.requestHash, registration_id: null, order_id: "order-1", created_at: new Date(), updated_at: new Date() }));
  mock.method(ticketOrderRepository, "findByEventAndId", async () => orderRow({ id: "order-1" }));
  const replay = await checkoutService.checkoutOnce(quick([{ ticketTypeCode: "GA", quantity: 3 }]), submission, FAKE_TX);
  assert.deepEqual([replay.outcome, replay.order.id], ["REPLAYED", "order-1"]);
  assert.equal(calls.createOrder.mock.callCount(), 1, "no second order, place or SMS");

  await assert.rejects(checkoutService.checkoutOnce(quick([{ ticketTypeCode: "GA", quantity: 2 }]), { ...submission, requestHash: "b".repeat(64) }, FAKE_TX), IdempotencyKeyReusedError);
});
