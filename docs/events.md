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
| Branch-limited staff and clients/venues | Organization-level only for now: branch-limited staff get 403. Revisit in 3b with branch events. |
| Venues' permission | Part of `EVENTS`; no separate menu item (reached from the Events area). |
