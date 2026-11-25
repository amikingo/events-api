import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { Transaction } from "sequelize";
import { ConflictError, EventNotPublishableError, InvalidEventStateError, ValidationAppError } from "../src/errors/app-errors.js";
import { customerAccountRepository } from "../src/repositories/customer-account.repository.js";
import { eventRepository } from "../src/repositories/event.repository.js";
import { organizationRepository } from "../src/repositories/organization.repository.js";
import { ticketTypeRepository } from "../src/repositories/ticket-type.repository.js";
import { venueRepository } from "../src/repositories/venue.repository.js";
import { eventService } from "../src/services/event.service.js";
import { transactionManager } from "../src/services/helpers.js";
import { eventRow, IDS, organizationRow, venueRow } from "./helpers/fixtures.js";

/** The event service against mocked repositories and a fake transaction: no database needed. */
const FAKE_TX = { id: "fake-transaction" } as unknown as Transaction;
/** Validated input always carries the transformed optional keys; undefined means "not sent". */
const NOT_SENT = { description: undefined, category: undefined };

beforeEach(() => {
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
  mock.method(organizationRepository, "findById", async () => organizationRow({ timezone: "Africa/Addis_Ababa" }));
  mock.method(eventRepository, "lockSlugsOfOrganization", async () => undefined);
  mock.method(eventRepository, "findByOrganizationAndSlug", async () => null);
  mock.method(eventRepository, "listSlugsWithPrefix", async () => []);
});
afterEach(() => mock.restoreAll());

// --- Creating -------------------------------------------------------------------------------------

function arrangeCreate() {
  return {
    createEvent: mock.method(eventRepository, "create", async () => eventRow()),
    createTicketType: mock.method(ticketTypeRepository, "create", async () => ({}) as never),
  };
}

test("a new event is DRAFT, UNLISTED and organization-wide, copies the organization's timezone, and gets General Admission in the same transaction", async () => {
  const calls = arrangeCreate();

  await eventService.createEvent(IDS.orgA, { ...NOT_SENT, name: "Banking Forum" }, IDS.user);

  const [values, options] = calls.createEvent.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(
    [values?.status, values?.visibility, values?.branch_id, values?.timezone, values?.slug, values?.capacity],
    ["DRAFT", "UNLISTED", null, "Africa/Addis_Ababa", "banking-forum", null],
  );
  assert.deepEqual(options, { transaction: FAKE_TX });

  const [ticket, ticketOptions] = calls.createTicketType.mock.calls[0]?.arguments ?? [];
  assert.deepEqual([ticket?.code, ticket?.name, ticket?.capacity, ticket?.is_active], ["GA", "General Admission", null, true]);
  assert.deepEqual(ticketOptions, { transaction: FAKE_TX }, "General Admission joins the event's transaction");
});

test("an explicit timezone overrides the organization's", async () => {
  const calls = arrangeCreate();
  await eventService.createEvent(IDS.orgA, { ...NOT_SENT, name: "London Roadshow", timezone: "Europe/London" }, IDS.user);
  const [values] = calls.createEvent.mock.calls[0]?.arguments ?? [];
  assert.equal(values?.timezone, "Europe/London");
});

test("a generated slug takes the first free suffix; a name with no Latin letters falls back to event", async () => {
  const calls = arrangeCreate();
  mock.method(eventRepository, "listSlugsWithPrefix", async (_organizationId: string, base: string) =>
    base === "banking-forum" ? ["banking-forum", "banking-forum-2"] : ["event"],
  );

  await eventService.createEvent(IDS.orgA, { ...NOT_SENT, name: "Banking Forum" }, IDS.user);
  await eventService.createEvent(IDS.orgA, { ...NOT_SENT, name: "የባንክ ፎረም" }, IDS.user);

  assert.equal(calls.createEvent.mock.calls[0]?.arguments[0]?.slug, "banking-forum-3");
  assert.equal(calls.createEvent.mock.calls[1]?.arguments[0]?.slug, "event-2");
});

test("an explicit slug already used by another event is refused", async () => {
  const calls = arrangeCreate();
  mock.method(eventRepository, "findByOrganizationAndSlug", async () => eventRow({ id: "another-event" }));

  await assert.rejects(
    eventService.createEvent(IDS.orgA, { ...NOT_SENT, name: "Banking Forum", slug: "banking-forum" }, IDS.user),
    (error: unknown) => error instanceof ConflictError && (error.details as { field: string }).field === "slug",
  );
  assert.equal(calls.createEvent.mock.callCount(), 0);
});

test("a client of another organization or an inactive venue is refused before anything is written", async () => {
  const calls = arrangeCreate();
  mock.method(customerAccountRepository, "findByOrganizationAndId", async () => null);
  await assert.rejects(
    eventService.createEvent(IDS.orgA, { ...NOT_SENT, name: "Forum", customer_account_id: IDS.customerAccount }, IDS.user),
    (error: unknown) =>
      error instanceof ValidationAppError && (error.details as { issues: Array<{ code: string }> }).issues[0]?.code === "not_in_organization",
  );

  mock.method(venueRepository, "findByOrganizationAndId", async () => venueRow({ is_active: false }));
  await assert.rejects(
    eventService.createEvent(IDS.orgA, { ...NOT_SENT, name: "Forum", venue_id: IDS.venue }, IDS.user),
    (error: unknown) => error instanceof ValidationAppError && (error.details as { issues: Array<{ code: string }> }).issues[0]?.code === "inactive",
  );
  assert.equal(calls.createEvent.mock.callCount(), 0);
});

// --- Status ---------------------------------------------------------------------------------------

function arrangeStatus(current: ReturnType<typeof eventRow>, activeTicketTypes = 1) {
  mock.method(eventRepository, "findByOrganizationAndId", async () => current);
  mock.method(ticketTypeRepository, "countActiveByEvent", async () => activeTicketTypes);
  return mock.method(eventRepository, "updateByOrganizationAndId", async () => eventRow({ status: "PUBLISHED" }));
}

test("publishing needs dates in order and an active ticket type; a ready draft is published", async () => {
  arrangeStatus(eventRow({ starts_at: null, ends_at: null }), 0);
  await assert.rejects(eventService.changeEventStatus(IDS.orgA, IDS.event, "PUBLISHED", IDS.user), (error: unknown) => {
    assert.ok(error instanceof EventNotPublishableError);
    assert.deepEqual((error.details as { missing: string[] }).missing, ["starts_at", "ends_at", "an active ticket type"]);
    return true;
  });
  mock.restoreAll();
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));

  const update = arrangeStatus(eventRow());
  const before = Date.now();
  await eventService.changeEventStatus(IDS.orgA, IDS.event, "PUBLISHED", IDS.user);
  const [, , values, options] = update.mock.calls[0]?.arguments ?? [];
  assert.equal(values?.status, "PUBLISHED");
  assert.ok(values?.published_at instanceof Date && values.published_at.getTime() >= before, "published_at is set in the same write");
  assert.deepEqual(options, { transaction: FAKE_TX });
});

test("published_at is set only by the first publication and kept when the event closes or is cancelled", async () => {
  const firstPublished = new Date("2026-11-20T10:00:00Z");
  for (const target of ["CLOSED", "CANCELLED"] as const) {
    const update = arrangeStatus(eventRow({ status: "PUBLISHED", published_at: firstPublished }));
    await eventService.changeEventStatus(IDS.orgA, IDS.event, target, IDS.user);
    const [, , values] = update.mock.calls[0]?.arguments ?? [];
    assert.deepEqual(values, { status: target, updated_by: IDS.user }, `${target} does not touch published_at`);
    mock.restoreAll();
    mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
  }
});

test("allowed transitions: DRAFT→PUBLISHED|CANCELLED, PUBLISHED→CLOSED|CANCELLED; CLOSED and CANCELLED are terminal", async () => {
  const refused: Array<[Parameters<typeof eventRow>[0], "PUBLISHED" | "CLOSED" | "CANCELLED"]> = [
    [{ status: "DRAFT" }, "CLOSED"],
    [{ status: "CLOSED" }, "PUBLISHED"],
    [{ status: "CLOSED" }, "CANCELLED"],
    [{ status: "CANCELLED" }, "PUBLISHED"],
  ];
  for (const [current, target] of refused) {
    const update = arrangeStatus(eventRow(current));
    await assert.rejects(eventService.changeEventStatus(IDS.orgA, IDS.event, target, IDS.user), InvalidEventStateError, `${current?.status}→${target}`);
    assert.equal(update.mock.callCount(), 0);
    mock.restoreAll();
    mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
  }

  for (const [current, target] of [
    [{ status: "DRAFT" }, "CANCELLED"],
    [{ status: "PUBLISHED" }, "CLOSED"],
    [{ status: "PUBLISHED" }, "CANCELLED"],
  ] as const) {
    const update = arrangeStatus(eventRow(current));
    await eventService.changeEventStatus(IDS.orgA, IDS.event, target, IDS.user);
    assert.equal(update.mock.callCount(), 1, `${current.status}→${target}`);
    mock.restoreAll();
    mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
  }
});

// --- Editing --------------------------------------------------------------------------------------

function arrangeUpdate(current: ReturnType<typeof eventRow>, options: { activeTicketTypes?: number; largestTicketLimit?: number | null } = {}) {
  mock.method(eventRepository, "findByOrganizationAndId", async () => current);
  mock.method(ticketTypeRepository, "countActiveByEvent", async () => options.activeTicketTypes ?? 1);
  mock.method(ticketTypeRepository, "maxCapacityByEvent", async () => options.largestTicketLimit ?? null);
  return mock.method(eventRepository, "updateByOrganizationAndId", async () => current);
}

test("after the first publication the slug is frozen, but the name and description can still change", async () => {
  const update = arrangeUpdate(eventRow({ status: "PUBLISHED" }));

  await assert.rejects(
    eventService.updateEvent(IDS.orgA, IDS.event, { ...NOT_SENT, slug: "new-forum-link" }, IDS.user),
    InvalidEventStateError,
  );
  assert.equal(update.mock.callCount(), 0);

  await eventService.updateEvent(IDS.orgA, IDS.event, { ...NOT_SENT, name: "Banking Forum 2027", description: "Updated" }, IDS.user);
  const [, , values] = update.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(values, { name: "Banking Forum 2027", description: "Updated", updated_by: IDS.user });
});

test("closing registration early keeps the event PUBLISHED; reopening rechecks the window", async () => {
  const update = arrangeUpdate(eventRow({ status: "PUBLISHED", visibility: "PUBLIC", registration_opens_at: new Date("2027-01-01T00:00:00Z") }));

  await eventService.updateEvent(IDS.orgA, IDS.event, { ...NOT_SENT, registration_closes_at: new Date("2027-02-01T00:00:00Z") }, IDS.user);
  const [, , values] = update.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(values, { registration_closes_at: new Date("2027-02-01T00:00:00Z"), updated_by: IDS.user }, "status and visibility untouched");

  await assert.rejects(
    eventService.updateEvent(IDS.orgA, IDS.event, { ...NOT_SENT, registration_closes_at: new Date("2026-12-01T00:00:00Z") }, IDS.user),
    ValidationAppError,
    "a cutoff before the opening is refused",
  );
});

test("a published event's dates can't be cleared, and a CLOSED or CANCELLED event can't be edited", async () => {
  arrangeUpdate(eventRow({ status: "PUBLISHED" }));
  await assert.rejects(eventService.updateEvent(IDS.orgA, IDS.event, { ...NOT_SENT, ends_at: null }, IDS.user), EventNotPublishableError);
  mock.restoreAll();
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));

  for (const status of ["CLOSED", "CANCELLED"] as const) {
    const update = arrangeUpdate(eventRow({ status }));
    await assert.rejects(eventService.updateEvent(IDS.orgA, IDS.event, { ...NOT_SENT, name: "Renamed" }, IDS.user), InvalidEventStateError, status);
    assert.equal(update.mock.callCount(), 0);
    mock.restoreAll();
    mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
  }
});

test("the event capacity can't drop below a ticket type's own limit", async () => {
  const update = arrangeUpdate(eventRow({ capacity: 500 }), { largestTicketLimit: 50 });

  await assert.rejects(eventService.updateEvent(IDS.orgA, IDS.event, { ...NOT_SENT, capacity: 40 }, IDS.user), InvalidEventStateError);
  assert.equal(update.mock.callCount(), 0);

  await eventService.updateEvent(IDS.orgA, IDS.event, { ...NOT_SENT, capacity: 50 }, IDS.user);
  assert.equal(update.mock.callCount(), 1, "a capacity equal to the largest ticket limit fits");
});
