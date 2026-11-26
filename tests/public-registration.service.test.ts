import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { Transaction } from "sequelize";
import { PRIVACY_NOTICE_VERSION } from "../src/config/privacy.js";
import { NotFoundError, PrivacyNoticeOutdatedError, ValidationAppError } from "../src/errors/app-errors.js";
import type { CustomerAuthContext } from "../src/middleware/authentication.js";
import { eventRepository, type PublicEventRow } from "../src/repositories/event.repository.js";
import { registrationRepository } from "../src/repositories/registration.repository.js";
import { customerAuthService } from "../src/services/customer-auth.service.js";
import { transactionManager } from "../src/services/helpers.js";
import { publicRegistrationService } from "../src/services/public-registration.service.js";
import { registrationService, type RegisterInput, type SubmissionRequest } from "../src/services/registration.service.js";
import { requestHash } from "../src/utils/request-hash.js";
import { eventRow, IDS, personRow, registrationRow, ticketTypeRow } from "./helpers/fixtures.js";

/** The public registration service against mocked repositories, the registration core and a fake transaction. */
const FAKE_TX = { id: "fake-transaction" } as unknown as Transaction;
const KEY = "0b9c1a52-6f1e-4c35-8d2a-2a9f9d3c7e11";
const EVENT: PublicEventRow = {
  ...eventRow({ status: "PUBLISHED", visibility: "UNLISTED", published_at: new Date("2026-11-01T00:00:00Z") }),
  organization: { name: "Selam Events", slug: "selam-events" },
  venue: null,
  coverFile: null,
};
const FORM = {
  first_name: "Liya",
  last_name: "Tesfaye",
  phone: "+251912000001",
  email: undefined,
  affiliation_name: undefined,
  country: undefined,
  ticket_type_code: "GA",
  privacy_notice_version: PRIVACY_NOTICE_VERSION,
};

let transactions = 0;
beforeEach(() => {
  transactions = 0;
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => {
    transactions += 1;
    return work(FAKE_TX);
  });
});
afterEach(() => mock.restoreAll());

function arrange(outcome: "CREATED" | "REPLAYED" | "UNCHANGED" = "CREATED") {
  mock.method(eventRepository, "findPublishedBySlugs", async () => EVENT);
  mock.method(registrationRepository, "findDetailsByEventAndId", async () => ({
    ...registrationRow({ source: "PUBLIC", registered_by: null }),
    person: personRow({ first_name: "Liya" }),
    ticketType: ticketTypeRow(),
  }));
  return mock.method(
    registrationService,
    "registerOnce",
    async (_input: RegisterInput, _submission: SubmissionRequest, _transaction: Transaction) => ({
      registration: registrationRow({ source: "PUBLIC", registered_by: null }),
      outcome,
    }),
  );
}

test("an unknown event or an outdated privacy notice is refused before any transaction", async () => {
  mock.method(eventRepository, "findPublishedBySlugs", async () => null);
  await assert.rejects(publicRegistrationService.registerFromPublicForm("selam-events", "nope", KEY, FORM), NotFoundError);

  const registerOnce = arrange();
  await assert.rejects(
    publicRegistrationService.registerFromPublicForm("selam-events", "partner-workshop", KEY, { ...FORM, privacy_notice_version: "2025-01-01" }),
    (error: unknown) => error instanceof PrivacyNoticeOutdatedError && (error.details as { current: string }).current === PRIVACY_NOTICE_VERSION,
  );
  assert.deepEqual([transactions, registerOnce.mock.callCount()], [0, 0]);
});

test("a visitor registers as a new PUBLIC guest with no actor, the ticket type code and the privacy evidence, behind the key", async () => {
  const registerOnce = arrange();
  const before = new Date();

  await publicRegistrationService.registerFromPublicForm("selam-events", "partner-workshop", KEY, FORM);

  const [input, submission, transaction] = registerOnce.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(
    [input?.organizationId, input?.eventId, input?.source, input?.actorId, input?.ticketTypeCode],
    [IDS.orgA, IDS.event, "PUBLIC", null, "GA"],
  );
  assert.ok(input && "person" in input.guest, "always a new, unlinked profile");
  assert.deepEqual(input?.guest, {
    person: { first_name: "Liya", last_name: "Tesfaye", email: undefined, phone: "+251912000001", affiliation_name: undefined, country: undefined },
  });
  assert.equal(input?.evidence?.privacyNoticeVersion, PRIVACY_NOTICE_VERSION);
  assert.ok(input?.evidence && input.evidence.shownAt >= before, "shown at the submission time");
  assert.deepEqual(submission, { scope: "PUBLIC_REGISTRATION", key: KEY, requestHash: requestHash({ event_id: IDS.event, body: FORM }) });
  assert.equal(transaction, FAKE_TX);
});

test("the reply carries only what the visitor needs: code, status, ticket type, event, organizer and first name", async () => {
  arrange();
  const { registration, replayed } = await publicRegistrationService.registerFromPublicForm("selam-events", "partner-workshop", KEY, FORM);

  assert.equal(replayed, false);
  assert.deepEqual(Object.keys(registration).sort(), ["code", "event", "guest", "organization", "registered_at", "status", "ticket_type"]);
  assert.deepEqual(registration.guest, { first_name: "Liya" });
  const serialized = JSON.stringify(registration);
  for (const id of Object.values(IDS)) assert.ok(!serialized.includes(id), `no internal id (${id})`);
  assert.ok(!serialized.includes("+251"), "the guest's phone is not echoed back");
});

test("a replayed request is reported as such", async () => {
  arrange("REPLAYED");
  const { replayed } = await publicRegistrationService.registerFromPublicForm("selam-events", "partner-workshop", KEY, FORM);
  assert.equal(replayed, true);
});

// --- Signed in with a Cheche account (Phase 6) ----------------------------------------------------

const GUEST_ID = "d1111111-1111-4111-8111-111111111111";
const ACCOUNT: CustomerAuthContext = {
  kind: "customer",
  token: "guest-access-token",
  userId: GUEST_ID,
  profile: { mobile: "+251911223344", firstname: "Hana", middlename: null, lastname: "Bekele" },
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

test("signed in, the account's mobile is used and the form's phone is ignored; the account is part of the retry hash", async () => {
  const registerOnce = arrange();
  const mobile = mock.method(customerAuthService, "accountMobile", async () => "+251911223344");

  await publicRegistrationService.registerFromPublicForm("selam-events", "partner-workshop", KEY, { ...FORM, phone: "+251999999999" }, ACCOUNT);

  assert.equal(mobile.mock.callCount(), 1);
  const [input, submission] = registerOnce.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(input?.guest, {
    account: {
      userId: GUEST_ID,
      mobile: "+251911223344",
      person: { first_name: "Liya", last_name: "Tesfaye", email: undefined, affiliation_name: undefined, country: undefined },
    },
  });
  const body = { ...FORM, phone: "+251999999999" };
  assert.equal(submission?.requestHash, requestHash({ event_id: IDS.event, body, user_id: GUEST_ID }));
  assert.notEqual(submission?.requestHash, requestHash({ event_id: IDS.event, body }), "another account's retry can't replay this one");
});

test("without an account the mobile is required (400 at body.phone); signed in it isn't", async () => {
  const registerOnce = arrange();
  mock.method(customerAuthService, "accountMobile", async () => "+251911223344");
  const noPhone = { ...FORM, phone: undefined };

  await assert.rejects(publicRegistrationService.registerFromPublicForm("selam-events", "partner-workshop", KEY, noPhone), (error: unknown) => {
    assert.ok(error instanceof ValidationAppError);
    assert.equal((error.details as { issues: Array<{ path: string }> }).issues[0]?.path, "body.phone");
    return true;
  });
  assert.equal(registerOnce.mock.callCount(), 0);

  await publicRegistrationService.registerFromPublicForm("selam-events", "partner-workshop", KEY, noPhone, ACCOUNT);
  assert.equal(registerOnce.mock.callCount(), 1);
});

test("a signed-in guest already registered for the event is reported as UNCHANGED", async () => {
  arrange("UNCHANGED");
  mock.method(customerAuthService, "accountMobile", async () => "+251911223344");
  const { outcome, replayed } = await publicRegistrationService.registerFromPublicForm("selam-events", "partner-workshop", KEY, FORM, ACCOUNT);
  assert.deepEqual([outcome, replayed], ["UNCHANGED", false]);
});

// --- Phase 7 step 1 ------------------------------------------------------------------------------------

test("a DETAILED event's holder fields apply to the public form: required ones must be given, hidden ones are refused", async () => {
  const registerOnce = arrange();
  mock.method(eventRepository, "findPublishedBySlugs", async () => ({
    ...EVENT,
    holder_fields: { name: "REQUIRED", mobile: "REQUIRED", email: "REQUIRED", affiliation: "HIDDEN", country: "OPTIONAL" },
  }));
  const issuesOf = (error: unknown) => (error as ValidationAppError & { details: { issues: Array<{ path: string; code: string }> } }).details.issues;

  await assert.rejects(publicRegistrationService.registerFromPublicForm("selam-events", "workshop", KEY, { ...FORM, affiliation_name: "Selam Bank" }), (error: unknown) => {
    assert.ok(error instanceof ValidationAppError);
    assert.deepEqual(issuesOf(error).map((issue) => [issue.path, issue.code]), [
      ["body.email", "required"],
      ["body.affiliation_name", "not_collected"],
    ]);
    return true;
  });
  assert.equal(registerOnce.mock.callCount(), 0, "refused before any transaction");

  await publicRegistrationService.registerFromPublicForm("selam-events", "workshop", KEY, { ...FORM, email: "liya@example.com" });
  assert.equal(registerOnce.mock.callCount(), 1);
});

test("a QUICK event keeps the form as it is", async () => {
  const registerOnce = arrange();
  mock.method(eventRepository, "findPublishedBySlugs", async () => ({
    ...EVENT,
    registration_mode: "QUICK" as const,
    holder_fields: { name: "REQUIRED", mobile: "REQUIRED", email: "REQUIRED", affiliation: "HIDDEN", country: "HIDDEN" },
  }));
  await publicRegistrationService.registerFromPublicForm("selam-events", "festival", KEY, FORM);
  assert.equal(registerOnce.mock.callCount(), 1);
});
