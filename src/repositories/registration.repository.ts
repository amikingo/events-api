import { col, fn, type CreationAttributes } from "sequelize";
import type { EventRow } from "../models/event.js";
import { AppEvent, Organization, Person, Registration, TicketType } from "../models/index.js";
import type { OrganizationRow } from "../models/organization.js";
import type { PersonRow } from "../models/person.js";
import type { RegistrationRow, RegistrationStatus } from "../models/registration.js";
import type { TicketTypeRow } from "../models/ticket-type.js";
import { toPlain, toPlainList } from "../utils/sequelize.js";
import { lockOptions, txOptions, type RepoOptions, type WriteOptions } from "./helpers.js";
import { personSearchWhere } from "./person-search.js";

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
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
] as const satisfies readonly (keyof RegistrationRow)[];

const PERSON_SUMMARY = ["id", "first_name", "last_name", "phone", "email", "affiliation_name", "is_active"] as const satisfies readonly (keyof PersonRow)[];
const TICKET_TYPE_SUMMARY = ["id", "code", "name"] as const satisfies readonly (keyof TicketTypeRow)[];
const EVENT_SUMMARY = ["id", "name", "slug", "starts_at", "ends_at", "timezone", "status"] as const satisfies readonly (keyof EventRow)[];

export type RegistrationUpdateValues = Partial<
  Pick<RegistrationRow, "ticket_type_id" | "status" | "source" | "registered_by" | "registered_at" | "cancelled_at" | "updated_by">
>;

/** A guest-list row: the registration with the guest's contact summary and the ticket type. */
export type RegistrationWithDetails = RegistrationRow & {
  person: Pick<PersonRow, (typeof PERSON_SUMMARY)[number]>;
  ticketType: Pick<TicketTypeRow, (typeof TICKET_TYPE_SUMMARY)[number]>;
};

/** A person's registration in their organization, with the event it is for (for confirming a returning guest). */
export type PersonRegistrationRow = RegistrationRow & {
  event: Pick<EventRow, (typeof EVENT_SUMMARY)[number]>;
  ticketType: Pick<TicketTypeRow, (typeof TICKET_TYPE_SUMMARY)[number]>;
};

const detailIncludes = [
  { model: Person, as: "person", required: true, attributes: [...PERSON_SUMMARY] },
  { model: TicketType, as: "ticketType", required: true, attributes: [...TICKET_TYPE_SUMMARY] },
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

/** Places taken at the event: only CONFIRMED registrations consume capacity. */
async function countConfirmedByEvent(organizationId: string, eventId: string, options: RepoOptions = {}): Promise<number> {
  return Registration.count({ where: { organization_id: organizationId, event_id: eventId, status: "CONFIRMED" }, ...txOptions(options) });
}

async function countConfirmedByTicketType(
  organizationId: string,
  eventId: string,
  ticketTypeId: string,
  options: RepoOptions = {},
): Promise<number> {
  return Registration.count({
    where: { organization_id: organizationId, event_id: eventId, ticket_type_id: ticketTypeId, status: "CONFIRMED" },
    ...txOptions(options),
  });
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
};

/** The guest list's filters and order, shared by the paged list and the export so both always match. */
function guestListQuery(organizationId: string, eventId: string, filters: RegistrationListFilters) {
  return {
    where: {
      organization_id: organizationId,
      event_id: eventId,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.ticketTypeId ? { ticket_type_id: filters.ticketTypeId } : {}),
    },
    attributes: [...attributes],
    include: [
      {
        model: Person,
        as: "person",
        required: true,
        attributes: [...PERSON_SUMMARY],
        ...(filters.q ? { where: personSearchWhere(filters.q, filters.phoneVariant ?? null) } : {}),
      },
      { model: TicketType, as: "ticketType", required: true, attributes: [...TICKET_TYPE_SUMMARY] },
    ],
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
    where: { organization_id: organizationId, person_id: personId },
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
 * Every registration of every profile linked to this Cheche account, in any organization (My Tickets). Only
 * profiles with this user_id count: unlinked profiles with the same mobile never do (claiming is deferred).
 */
async function listByAccount(userId: string, options: RepoOptions = {}): Promise<AccountRegistrationRow[]> {
  const rows = await Registration.findAll({
    attributes: [...attributes],
    include: [
      { model: Person, as: "person", required: true, attributes: [], where: { user_id: userId } },
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
  listByEvent,
  listAllByEvent,
  listByPerson,
  listByAccount,
  updateByEventAndId,
};
