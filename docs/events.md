# Events (Phase 3)

Product behaviour comes from [`docs/event-management-mvp1-final.md`](event-management-mvp1-final.md) (the
23 November 2026 specification, sections 3, 4, 5 and 7). Build order: 3a clients and venues; 3b events and ticket
types; 3c public catalog and event detail; 3d cover upload.

## Permissions and menu

| Module | Covers | Menu |
|---|---|---|
| `EVENTS` | events, ticket types, venues | *Event Management › Events* (`/events`) |
| `CUSTOMERS` | clients (`customer_account`) | *Event Management › Clients* (`/clients`) |

Default roles: `OWNER` may view, create and update both; `VIEWER` may view both. There is no delete: records are
deactivated (`PATCH …/status`) so events keep their history. Existing organizations got these grants through
migration `20261125000003`; new ones get them from `src/utils/default-roles.ts`. `REGISTRATIONS` arrives in Phase 4.

All routes are organization-scoped (`/v1/organizations/:organizationId/...`) and authorized at organization
level, so branch-limited staff cannot reach them yet (see "Product rules decided for 3a").

## 3a: clients and venues

### Clients: `customer_account`

The client **commissioning** an event: an organization (ABC Bank) or an individual (Hana Bekele, for her
wedding). Not an attendee; attendees are `person` (Phase 4). An organizer running its own event leaves the
event's client empty.

| Field | Rules |
|---|---|
| `name` | required, 1–255 |
| `kind` | `ORGANIZATION` (default) or `INDIVIDUAL` |
| `type` | an organizational client's sector, free text up to 80 (e.g. Corporate, NGO, Government). **Must be empty for an individual**: refused with 400 on create, and on update when the result would combine `INDIVIDUAL` with a type (`type_not_allowed_for_individual`); a database check is the backstop |
| `primary_contact_name` | optional, up to 255 |
| `primary_contact_email` | optional, a valid email |
| `primary_contact_phone` | optional, local or international (digits, spaces, `+ - ( )`). Ethiopian mobiles are stored as `+251…`; other numbers as typed |
| `is_active` | deactivate instead of deleting |

Endpoints: `POST`, `GET` (list, `?page&pageSize&is_active`), `GET /{customerAccountId}`, `PATCH /{customerAccountId}`,
`PATCH /{customerAccountId}/status` under `/v1/organizations/{organizationId}/customer-accounts`.

### Venues: `venue`

A reusable physical location. `capacity` describes the place; an event's own capacity (3b) sets its booking limit.

| Field | Rules |
|---|---|
| `name` | required, 1–255 |
| `address` | optional, up to 500 |
| `city` | optional, up to 120 |
| `country` | optional ISO 3166-1 alpha-2 code, stored upper-case (`et` → `ET`) |
| `capacity` | optional positive whole number |
| `is_active` | deactivate instead of deleting |

Endpoints: the same five under `/v1/organizations/{organizationId}/venues`.

Both tables carry `UNIQUE (organization_id, id)`, so events (3b) can only point at a client or venue of their own
organization; PostgreSQL enforces it.

## Product rules decided for 3a (accepted 25 November 2026)

| Rule | Decision |
|---|---|
| Is a client's `type` a fixed list? | Free text for now (the spec says "such as corporate, NGO or government"). |
| Phone format for clients | Local or international accepted; Ethiopian mobiles normalized to `+251…`. |
| Country format | ISO 3166-1 alpha-2 (`ET`). |
| Duplicate names | Allowed for clients and venues (no uniqueness). |
| Branch-limited staff and clients/venues | Organization-level only during the organization-first pilot: branch-limited staff get 403 (kept in 3b for events too). |
| Venues' permission | Part of `EVENTS`; no separate menu item (reached from the Events area). |

## 3b: events and ticket types

Decisions of 25 November 2026 (they refine the spec where it was silent).

### Organization defaults

`organization.country` (`ET`), `timezone` (`Africa/Addis_Ababa`) and `default_currency` (`ETB`), set on create and
editable with `PATCH /v1/organizations/{organizationId}` (`ORGANIZATIONS.update`; owners have it). Codes are
checked and stored upper-case; the timezone must be a real IANA zone and is stored in its canonical spelling.

### Events

| Rule | Behaviour |
|---|---|
| New event | `DRAFT`, `visibility = UNLISTED` (choose `PUBLIC` for the catalog), General Admission added in the same transaction |
| Timezone | copied from the organization when created; may be overridden; later changes to the organization never touch existing events |
| Slug | generated from the name when omitted (`banking-forum`, `banking-forum-2`, …; a name with no Latin letters gives `event`, `event-2`, …); a requested slug must be free (409); editable only while `DRAFT`, frozen after the first publication even if the name changes |
| Branch | `branch_id = NULL` is organization-wide, even when a default `MAIN` exists. Staff may pick any **active branch of their organization**; the number of branches does not matter |
| Client, venue, cover | optional; when set, an active row of the same organization (400 otherwise; composite foreign keys are the backstop) |
| Dates | `starts_at < ends_at` and `registration_opens_at < registration_closes_at` when both are set; instants need an offset or `Z` |
| Capacity | optional; when set, a positive integer that every ticket type's own limit must fit within. It can't be lowered below the largest ticket limit (409) |
| Publishing | needs a name, a valid slug and timezone, `starts_at < ends_at`, and at least one active ticket type (`409 event_not_publishable`, `details.missing`); venue and cover may be empty |
| Status changes | `PATCH …/status`: `DRAFT → PUBLISHED \| CANCELLED`, `PUBLISHED → CLOSED \| CANCELLED`. `CLOSED` and `CANCELLED` are terminal: no edits, no ticket changes |
| Stopping sign-ups early | set `registration_closes_at`; the event stays `PUBLISHED` (and in the catalog if `PUBLIC`). Extending or clearing it reopens sign-ups before the event ends; the window is rechecked |
| `display_status` | `LIVE` for a published event while `starts_at <= now < ends_at`; otherwise the stored status (a cancelled event stays `CANCELLED`) |

### Ticket types

Under `/v1/organizations/{organizationId}/events/{eventId}/ticket-types` (`EVENTS.view` to list, `EVENTS.update` to
change). Code unique within the event (upper-case); optional `capacity` (NULL = no separate limit, it draws on the
event's limit only); `display_order` (default: after the last). A ticket limit must fit within the event capacity
when both are set; limits may add up to more, because all categories share the event's pool. General Admission
(`GA`) can be renamed or deactivated, but a **published** event must keep at least one active ticket type.
Every change locks the event first and the ticket type second (the spec's lock order).

### Files

`file` holds tenant-scoped metadata (only `EVENT_COVER` for now). Uploading and the storage provider are 3d; until
then `cover_file_id` stays empty in practice.

### Permissions

No new grants: events and ticket types use `EVENTS` (granted to `OWNER`/`VIEWER` in 3a), the organization's
defaults use `ORGANIZATIONS.update` (already `OWNER`'s). Branch-limited staff still get 403 for the back office.
