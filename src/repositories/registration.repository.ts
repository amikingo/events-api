import { col, fn, Op, type CreationAttributes, type WhereOptions } from "sequelize";
import type { EventRow } from "../models/event.js";
import { AppEvent, Organization, Person, Registration, TicketAdmission, TicketOrder, TicketType } from "../models/index.js";
import type { OrganizationRow } from "../models/organization.js";
import type { PersonRow } from "../models/person.js";
import type { RegistrationRow, RegistrationStatus } from "../models/registration.js";
import type { TicketAdmissionRow } from "../models/ticket-admission.js";
import type { TicketOrderRow } from "../models/ticket-order.js";
import type { TicketTypeRow } from "../models/ticket-type.js";
import { toPlain, toPlainList } from "../utils/sequelize.js";
import { lockOptions, txOptions, type RepoOptions, type WriteOptions } from "./helpers.js";
import { likePattern } from "./person-search.js";

/** Phase 7 step 3: an issued ticket (what the guest list, a profile and My Tickets show) and a place-taking one. */
const ISSUED_STATUSES = ["CONFIRMED", "CANCELLED"] as const satisfies readonly RegistrationStatus[];
const PLACE_TAKING_STATUSES = ["CONFIRMED", "HELD"] as const satisfies readonly RegistrationStatus[];

/** Explicit projection: never `SELECT *`. */
const attributes = [
  "id",
  "organization_id",
  "event_id",
  "person_id",
  "ticket_type_id",
  "status",
  "source",
  "registered_by",
  "registered_at",
  "cancelled_at",
  "code",
  "privacy_notice_version",
  "privacy_notice_shown_at",
  "consent_purpose",
  "consent_version",
  "consented_at",
  "order_id",
  "price_amount",
  "currency",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
] as const satisfies readonly (keyof RegistrationRow)[];

const PERSON_SUMMARY = ["id", "first_name", "last_name", "phone", "email", "affiliation_name", "is_active"] as const satisfies readonly (keyof PersonRow)[];
const TICKET_TYPE_SUMMARY = ["id", "code", "name"] as const satisfies readonly (keyof TicketTypeRow)[];
const ORDER_SUMMARY = ["id", "reference", "buyer_mobile"] as const satisfies readonly (keyof TicketOrderRow)[];
const EVENT_SUMMARY = ["id", "name", "slug", "starts_at", "ends_at", "timezone", "status"] as const satisfies readonly (keyof EventRow)[];
const ADMISSION_SUMMARY = ["admitted_at", "admitted_by"] as const satisfies readonly (keyof TicketAdmissionRow)[];

export type RegistrationUpdateValues = Partial<
  Pick<RegistrationRow, "ticket_type_id" | "status" | "source" | "registered_by" | "registered_at" | "cancelled_at" | "updated_by">
>;

/**
 * A guest-list row: the ticket with the holder's contact summary (null for an unnamed QUICK ticket, Phase 7), the
 * ticket type and the order it came with (reference and buyer mobile).
 */
export type RegistrationWithDetails = RegistrationRow & {
  person: Pick<PersonRow, (typeof PERSON_SUMMARY)[number]> | null;
  ticketType: Pick<TicketTypeRow, (typeof TICKET_TYPE_SUMMARY)[number]>;
  order: Pick<TicketOrderRow, (typeof ORDER_SUMMARY)[number]>;
  /** Phase 8: the ticket's admission at the door, or null; absent where a read doesn't load it. */
  admission?: Pick<TicketAdmissionRow, (typeof ADMISSION_SUMMARY)[number]> | null;
};

/** A person's registration in their organization, with the event it is for (for confirming a returning guest). */
export type PersonRegistrationRow = RegistrationRow & {
  event: Pick<EventRow, (typeof EVENT_SUMMARY)[number]>;
  ticketType: Pick<TicketTypeRow, (typeof TICKET_TYPE_SUMMARY)[number]>;
};

const detailIncludes = [
  { model: Person, as: "person", required: false, attributes: [...PERSON_SUMMARY] },
  { model: TicketType, as: "ticketType", required: true, attributes: [...TICKET_TYPE_SUMMARY] },
  { model: TicketOrder, as: "order", required: true, attributes: [...ORDER_SUMMARY] },
  { model: TicketAdmission, as: "admission", required: false, attributes: [...ADMISSION_SUMMARY] },
];

async function create(values: CreationAttributes<Registration>, options: WriteOptions = {}): Promise<RegistrationRow> {
  const row = await Registration.create(values, txOptions(options));
  return row.get({ plain: true });
}

// Every read/write is keyed by organization_id + event_id (+ id or person). An id alone is never a tenant boundary.
async function findByEventAndId(
  organizationId: string,
  eventId: string,
  registrationId: string,
  options: RepoOptions = {},
): Promise<RegistrationRow | null> {
  const row = await Registration.findOne({
    where: { organization_id: organizationId, event_id: eventId, id: registrationId },
    attributes: [...attributes],
    ...txOptions(options),
    ...lockOptions(options),
  });
  return toPlain<RegistrationRow>(row);
}

/** The ticket behind a code at one event (Phase 8: the door). A code from another event or tenant is simply not found. */
async function findByEventAndCode(organizationId: string, eventId: string, code: string, options: RepoOptions = {}): Promise<RegistrationRow | null> {
  const row = await Registration.findOne({
    where: { organization_id: organizationId, event_id: eventId, code },
    attributes: [...attributes],
    ...txOptions(options),
    ...lockOptions(options),
  });
  return toPlain<RegistrationRow>(row);
}

async function findByEventAndPerson(
  organizationId: string,
  eventId: string,
  personId: string,
  options: RepoOptions = {},
): Promise<RegistrationRow | null> {
  const row = await Registration.findOne({
    where: { organization_id: organizationId, event_id: eventId, person_id: personId },
    attributes: [...attributes],
    ...txOptions(options),
    ...lockOptions(options),
  });
  return toPlain<RegistrationRow>(row);
}

async function findDetailsByEventAndId(
  organizationId: string,
  eventId: string,
  registrationId: string,
  options: RepoOptions = {},
): Promise<RegistrationWithDetails | null> {
  const row = await Registration.findOne({
    where: { organization_id: organizationId, event_id: eventId, id: registrationId },
    attributes: [...attributes],
    include: detailIncludes,
    ...txOptions(options),
  });
  return toPlain<RegistrationWithDetails>(row);
}

async function codeExists(code: string, options: RepoOptions = {}): Promise<boolean> {
  return (await Registration.count({ where: { code }, ...txOptions(options) })) > 0;
}

/**
 * Places taken at the event: CONFIRMED tickets and, since Phase 7 step 3, HELD ones (places held while an order is
 * paid). Expired holds are released under the event lock before counting (paymentService.releaseExpiredHolds).
 */
async function countConfirmedByEvent(organizationId: string, eventId: string, options: RepoOptions = {}): Promise<number> {
  return Registration.count({ where: { organization_id: organizationId, event_id: eventId, status: [...PLACE_TAKING_STATUSES] }, ...txOptions(options) });
}

async function countConfirmedByTicketType(
  organizationId: string,
  eventId: string,
  ticketTypeId: string,
  options: RepoOptions = {},
): Promise<number> {
  return Registration.count({
    where: { organization_id: organizationId, event_id: eventId, ticket_type_id: ticketTypeId, status: [...PLACE_TAKING_STATUSES] },
    ...txOptions(options),
  });
}

/**
 * Phase 7: confirmed tickets held at the event by one buyer mobile (E.164), across every order: what the purchase
 * limit counts. Cancelled tickets don't count, so cancelling gives the allowance back. Held ones do (step 3).
 */
async function countConfirmedByBuyerMobile(organizationId: string, eventId: string, buyerMobile: string, options: RepoOptions = {}): Promise<number> {
  return Registration.count({
    where: { organization_id: organizationId, event_id: eventId, status: [...PLACE_TAKING_STATUSES] },
    include: [{ model: TicketOrder, as: "order", required: true, attributes: [], where: { buyer_mobile: buyerMobile } }],
    ...txOptions(options),
  });
}

/**
 * Phase 9: places a capacity can't drop below: CONFIRMED tickets (admitted ones counted once) plus HELD tickets whose
 * order's hold hasn't expired. Cancelled tickets, released ones and lapsed holds don't count. `ticketTypeId` narrows
 * it to one ticket type.
 */
async function countSecured(organizationId: string, eventId: string, now: Date, ticketTypeId: string | null, options: RepoOptions = {}): Promise<{ confirmed: number; held: number }> {
  const scope = { organization_id: organizationId, event_id: eventId, ...(ticketTypeId ? { ticket_type_id: ticketTypeId } : {}) };
  const confirmed = await Registration.count({ where: { ...scope, status: "CONFIRMED" }, ...txOptions(options) });
  const held = await Registration.count({
    where: { ...scope, status: "HELD" },
    include: [{ model: TicketOrder, as: "order", required: true, attributes: [], where: { status: "PENDING_PAYMENT", hold_expires_at: { [Op.gt]: now } } }],
    ...txOptions(options),
  });
  return { confirmed, held };
}

/** Phase 9: a ticket of the event as cancelling the event sees it: its order, price and whether it was admitted. */
export type CancellableTicket = Pick<RegistrationRow, "id" | "order_id" | "status" | "price_amount" | "currency"> & { admitted: boolean };

/** Phase 9: the event's CONFIRMED tickets, each with whether it was admitted (read under the event lock). */
async function listConfirmedWithAdmission(organizationId: string, eventId: string, options: RepoOptions = {}): Promise<CancellableTicket[]> {
  const rows = (await Registration.findAll({
    where: { organization_id: organizationId, event_id: eventId, status: "CONFIRMED" },
    attributes: ["id", "order_id", "status", "price_amount", "currency"],
    include: [{ model: TicketAdmission, as: "admission", required: false, attributes: ["id"] }],
    ...txOptions(options),
  })) as unknown as Array<{ get: (options: { plain: true }) => Pick<RegistrationRow, "id" | "order_id" | "status" | "price_amount" | "currency"> & { admission: { id: string } | null } }>;
  return rows.map((row) => {
    const plain = row.get({ plain: true });
    return { id: plain.id, order_id: plain.order_id, status: plain.status, price_amount: plain.price_amount, currency: plain.currency, admitted: plain.admission !== null };
  });
}

/** Phase 9: cancels the given CONFIRMED tickets of the event at once (cancelling the event); returns how many changed. */
async function cancelByIds(organizationId: string, eventId: string, ids: readonly string[], actorId: string | null, options: WriteOptions = {}): Promise<number> {
  if (ids.length === 0) return 0;
  const [count] = await Registration.update(
    { status: "CANCELLED", cancelled_at: new Date(), updated_by: actorId },
    { where: { organization_id: organizationId, event_id: eventId, id: [...ids], status: "CONFIRMED" }, ...txOptions(options) },
  );
  return count;
}

/** Phase 9: the orders of the event that hold at least one CONFIRMED ticket (the buyers told about a reschedule). */
async function listOrderIdsWithConfirmed(organizationId: string, eventId: string, options: RepoOptions = {}): Promise<string[]> {
  const rows = (await Registration.findAll({
    where: { organization_id: organizationId, event_id: eventId, status: "CONFIRMED" },
    attributes: [[fn("DISTINCT", col("order_id")), "order_id"]],
    raw: true,
    ...txOptions(options),
  })) as unknown as Array<{ order_id: string }>;
  return rows.map((row) => row.order_id);
}

/** Confirmed places per ticket type of the event (ticket types without any are absent). */
async function countConfirmedPerTicketType(organizationId: string, eventId: string, options: RepoOptions = {}): Promise<Map<string, number>> {
  const rows = (await Registration.findAll({
    where: { organization_id: organizationId, event_id: eventId, status: "CONFIRMED" },
    attributes: ["ticket_type_id", [fn("COUNT", col("id")), "confirmed"]],
    group: ["ticket_type_id"],
    raw: true,
    ...txOptions(options),
  })) as unknown as Array<{ ticket_type_id: string; confirmed: string | number }>;
  return new Map(rows.map((row) => [row.ticket_type_id, Number(row.confirmed)]));
}

export type RegistrationListFilters = {
  status?: RegistrationStatus | undefined;
  ticketTypeId?: string | undefined;
  q?: string | undefined;
  phoneVariant?: string | null;
  /** Phase 8: only tickets admitted at the door (true) or not yet (false). */
  checkedIn?: boolean | undefined;
};

/**
 * The guest-list search: the holder's names, email and phone (case-insensitive, substring; an Ethiopian mobile also
 * matches its +251 form), and since Phase 7 the ticket code and the order's buyer mobile, so an unnamed QUICK ticket
 * can be found too.
 */
function guestSearchWhere(q: string, phoneVariant: string | null): WhereOptions {
  const pattern = likePattern(q);
  return {
    [Op.or]: [
      { "$person.first_name$": { [Op.iLike]: pattern } },
      { "$person.last_name$": { [Op.iLike]: pattern } },
      { "$person.email$": { [Op.iLike]: pattern } },
      { "$person.phone$": { [Op.iLike]: pattern } },
      { code: q.trim().toUpperCase() },
      ...(phoneVariant ? [{ "$person.phone$": phoneVariant }, { "$order.buyer_mobile$": phoneVariant }] : []),
    ],
  };
}

/** The guest list's filters and order, shared by the paged list and the export so both always match. */
function guestListQuery(organizationId: string, eventId: string, filters: RegistrationListFilters) {
  return {
    where: {
      organization_id: organizationId,
      event_id: eventId,
      // Only issued tickets: held and released places of unpaid orders aren't guests (Phase 7 step 3).
      status: filters.status ?? [...ISSUED_STATUSES],
      ...(filters.ticketTypeId ? { ticket_type_id: filters.ticketTypeId } : {}),
      ...(filters.q ? guestSearchWhere(filters.q, filters.phoneVariant ?? null) : {}),
      ...(filters.checkedIn === undefined ? {} : { "$admission.id$": filters.checkedIn ? { [Op.ne]: null } : { [Op.is]: null } }),
    },
    attributes: [...attributes],
    include: detailIncludes,
    order: [
      ["registered_at", "DESC"],
      ["id", "ASC"],
    ] as Array<[string, string]>,
  };
}

/** The guest list, newest first. `q` searches the guest's names, email and phone. */
async function listByEvent(
  organizationId: string,
  eventId: string,
  filters: RegistrationListFilters & { limit: number; offset: number },
  options: RepoOptions = {},
): Promise<{ rows: RegistrationWithDetails[]; count: number }> {
  const { rows, count } = await Registration.findAndCountAll({
    ...guestListQuery(organizationId, eventId, filters),
    limit: filters.limit,
    offset: filters.offset,
    ...txOptions(options),
  });
  return { rows: toPlainList<RegistrationWithDetails>(rows), count };
}

/** Every registration matching the guest-list filters, in the list's order, without paging (the CSV export). */
async function listAllByEvent(
  organizationId: string,
  eventId: string,
  filters: RegistrationListFilters,
  options: RepoOptions = {},
): Promise<RegistrationWithDetails[]> {
  const rows = await Registration.findAll({ ...guestListQuery(organizationId, eventId, filters), ...txOptions(options) });
  return toPlainList<RegistrationWithDetails>(rows);
}

/** A person's registrations in their organization, most recent event first. */
async function listByPerson(organizationId: string, personId: string, options: RepoOptions = {}): Promise<PersonRegistrationRow[]> {
  const rows = await Registration.findAll({
    where: { organization_id: organizationId, person_id: personId, status: [...ISSUED_STATUSES] },
    attributes: [...attributes],
    include: [
      { model: AppEvent, as: "event", required: true, attributes: [...EVENT_SUMMARY] },
      { model: TicketType, as: "ticketType", required: true, attributes: [...TICKET_TYPE_SUMMARY] },
    ],
    order: [
      [{ model: AppEvent, as: "event" }, "starts_at", "DESC NULLS LAST"],
      ["id", "ASC"],
    ],
    ...txOptions(options),
  });
  return toPlainList<PersonRegistrationRow>(rows);
}

/** One of a signed-in guest's registrations, across organizers (My Tickets, Phase 6). */
export type AccountRegistrationRow = RegistrationRow & {
  event: Pick<EventRow, (typeof EVENT_SUMMARY)[number]> & { organization: Pick<OrganizationRow, "name" | "slug"> };
  ticketType: Pick<TicketTypeRow, (typeof TICKET_TYPE_SUMMARY)[number]>;
};

/**
 * Every ticket of this Cheche account, in any organization (My Tickets): tickets of profiles linked to the account,
 * and since Phase 7 tickets of orders the account bought while signed in (a verified identity). Unlinked profiles
 * or orders with the same mobile never count (claiming is deferred).
 */
async function listByAccount(userId: string, options: RepoOptions = {}): Promise<AccountRegistrationRow[]> {
  const rows = await Registration.findAll({
    where: { status: [...ISSUED_STATUSES], [Op.or]: [{ "$person.user_id$": userId }, { "$order.buyer_user_id$": userId }] },
    attributes: [...attributes],
    include: [
      { model: Person, as: "person", required: false, attributes: [] },
      { model: TicketOrder, as: "order", required: true, attributes: [] },
      {
        model: AppEvent,
        as: "event",
        required: true,
        attributes: [...EVENT_SUMMARY],
        include: [{ model: Organization, as: "organization", required: true, attributes: ["name", "slug"] }],
      },
      { model: TicketType, as: "ticketType", required: true, attributes: [...TICKET_TYPE_SUMMARY] },
    ],
    order: [
      [{ model: AppEvent, as: "event" }, "starts_at", "ASC NULLS LAST"],
      ["id", "ASC"],
    ],
    ...txOptions(options),
  });
  return toPlainList<AccountRegistrationRow>(rows);
}

/** Phase 7: the tickets of one order, with their details, in the order they were issued. */
async function listByOrder(organizationId: string, eventId: string, orderId: string, options: RepoOptions = {}): Promise<RegistrationWithDetails[]> {
  const rows = await Registration.findAll({
    where: { organization_id: organizationId, event_id: eventId, order_id: orderId },
    attributes: [...attributes],
    include: detailIncludes,
    order: [
      ["created_at", "ASC"],
      ["code", "ASC"],
    ],
    ...txOptions(options),
  });
  return toPlainList<RegistrationWithDetails>(rows);
}

/** Phase 7 step 3: a held ticket of a paid order becomes a CONFIRMED ticket with its code. */
async function issueHeld(organizationId: string, eventId: string, registrationId: string, code: string, options: WriteOptions = {}): Promise<void> {
  await Registration.update(
    { status: "CONFIRMED", code, registered_at: new Date() },
    { where: { organization_id: organizationId, event_id: eventId, id: registrationId, status: ["HELD", "RELEASED"] }, ...txOptions(options) },
  );
}

/** Phase 7 step 3: every held ticket of an order gives its place back (the order ended unpaid). */
async function releaseHeldByOrder(organizationId: string, eventId: string, orderId: string, options: WriteOptions = {}): Promise<number> {
  const [count] = await Registration.update(
    { status: "RELEASED" },
    { where: { organization_id: organizationId, event_id: eventId, order_id: orderId, status: "HELD" }, ...txOptions(options) },
  );
  return count;
}

/** Event-scoped update + read-back inside the same transaction. */
async function updateByEventAndId(
  organizationId: string,
  eventId: string,
  registrationId: string,
  values: RegistrationUpdateValues,
  options: WriteOptions = {},
): Promise<RegistrationRow | null> {
  await Registration.update(values, { where: { organization_id: organizationId, event_id: eventId, id: registrationId }, ...txOptions(options) });
  return findByEventAndId(organizationId, eventId, registrationId, options);
}

export const registrationRepository = {
  create,
  findByEventAndId,
  findByEventAndPerson,
  findDetailsByEventAndId,
  codeExists,
  countConfirmedByEvent,
  countConfirmedByTicketType,
  countConfirmedPerTicketType,
  countConfirmedByBuyerMobile,
  countSecured,
  listConfirmedWithAdmission,
  cancelByIds,
  listOrderIdsWithConfirmed,
  findByEventAndCode,
  listByEvent,
  listAllByEvent,
  listByPerson,
  listByAccount,
  listByOrder,
  issueHeld,
  releaseHeldByOrder,
  updateByEventAndId,
};
