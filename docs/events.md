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

### Product rules decided for 3b (accepted 25 November 2026)

| Rule | Decision |
|---|---|
| Event name with no Latin letters (e.g. Amharic only) | The slug becomes `event`, `event-2`, …; staff can change it while `DRAFT` |
| Requested slug already taken | `409`, no automatic suffix (suffixes apply only to generated slugs) |
| Editing `CLOSED` or `CANCELLED` events | Not allowed at all (`409 invalid_event_state`), including ticket types |
| Asking for the current status again | Returns the event unchanged (no error, nothing written) |

### Ticket types

Under `/v1/organizations/{organizationId}/events/{eventId}/ticket-types` (`EVENTS.view` to list, `EVENTS.update` to
change). Code unique within the event (upper-case); optional `capacity` (NULL = no separate limit, it draws on the
event's limit only); `display_order` (default: after the last). A ticket limit must fit within the event capacity
when both are set; limits may add up to more, because all categories share the event's pool. General Admission
(`GA`) can be renamed or deactivated, but a **published** event must keep at least one active ticket type.
Every change locks the event first and the ticket type second (the spec's lock order).

### Files

`file` holds tenant-scoped metadata (only `EVENT_COVER` for now). Uploading and the storage provider arrived in 3d
(below).

### Permissions

No new grants: events and ticket types use `EVENTS` (granted to `OWNER`/`VIEWER` in 3a), the organization's
defaults use `ORGANIZATIONS.update` (already `OWNER`'s). Branch-limited staff still get 403 for the back office.

## 3c: public catalog and event pages (no login)

Decisions of 25 November 2026. Both routes are rate limited per IP (`publicReadLimiter`, 120 requests a minute).

### `GET /v1/public/events`: the catalog

- Lists **upcoming and live** events: `status = PUBLISHED`, `visibility = PUBLIC`, organization active, and
  `now < ends_at`. An event leaves the catalog at its exact end time.
- Sorted by `starts_at`, then id, so pages are stable. `?page&pageSize` as everywhere.
- Filters: `?category=` (exact, ignoring case) and `?organization=` (an organization slug). The filters and
  `meta.count` follow the same rules as the list.
- Each card carries what a clickable card needs: `name`, `slug`, `organization { name, slug }`, `starts_at`, `ends_at`,
  `timezone`, `display_status`, `category`, `venue { name, address, city, country }` or null, `cover` (null until 3d),
  and `registration_open`.

### `GET /v1/public/organizations/{organizationSlug}/events/{eventSlug}`: the event page

- Resolved by **both** slugs, so two organizers may use the same event slug.
- Opens any event **published at least once** (`published_at` set): PUBLISHED events of either visibility (so
  UNLISTED events work by link), and events that have since ended, closed or been cancelled (they show
  `display_status`, e.g. `CANCELLED`).
- **404** for drafts, events cancelled before they were ever published, and events of an inactive organization.
- Adds `description`, `registration_opens_at`, `registration_closes_at`, and the **active** ticket types by
  `code` and `name`.

### `registration_open`

`true` only for a `PUBLISHED` event that has not ended (`now < ends_at`) and is inside its registration window:
the opening time is inclusive, the closing time exclusive, and an unset boundary adds no restriction. Stopping
sign-ups early (`registration_closes_at` in the past) keeps the event in the catalog with `registration_open = false`.
Capacity joins this check in Phase 4.

### What stays private

The commissioning client, staff, internal ids (`id`, `organization_id`, `branch_id`, …), `published_at` and audit
fields are never returned by public routes (`mappers/event.mapper.ts`).

### `published_at`

Server-managed, never accepted from clients. Set once, in the transaction that first publishes the event, and kept
when it closes or is cancelled. Migration `20261125000200` backfilled existing rows: PUBLISHED and CLOSED events
got `updated_at` as a **fallback**, because no publication time was recorded before (it is never earlier than the
real first publication, and exact if the event wasn't edited after publishing). Existing CANCELLED events stayed
NULL, because nothing proves they were ever published, so they stay private.

## 3d: cover images

Covers are stored the way bookings_api stores files: on the API server's disk, served by the API itself.

### Endpoints

| Method and path | Permission | Does |
|---|---|---|
| `PUT /v1/organizations/{organizationId}/events/{eventId}/cover` | `EVENTS.update` | Uploads an image and makes it the event's cover (replaces the current one) |
| `DELETE /v1/organizations/{organizationId}/events/{eventId}/cover` | `EVENTS.update` | Removes the cover from the event (`cover: null`) |

Both reply with the staff event, which now carries `cover: { url } | null`. The public card and event page carry the
same `cover`. `url` is a **path** (`/assets/uploads/events/covers/<uuid>.png`); the frontend prefixes the API's
origin.

### The upload

- `multipart/form-data` with exactly **one file in the field `file`** and nothing else. A second file, any other field,
  or the file in another field: 400 `validation_error`. No file at all, or a JSON body: 400 (`file_required`).
- **JPEG, PNG or WebP, up to 5 MB.** The type is read from the file's first bytes, never from its name or the
  Content-Type the browser sent; anything else is 415 `unsupported_file_type` (SVG and GIF included). Over 5 MB is 413
  `payload_too_large`. No resizing.
- The body is parsed **after** authentication and the permission check, and held in memory until the type is
  confirmed, so a refused upload never touches the disk.
- A CLOSED or CANCELLED event's cover can no longer change: 409 `invalid_event_state`. DRAFT and PUBLISHED events can.
- The stored name is a random UUID with the detected extension; the original name is kept only as metadata.

### Storage

- Folder: `FILES_DIR` (optional, absolute path). When unset, `/assets/uploads`, the bookings_api rule. In production
  this folder is a **mounted volume**, so files survive redeploys; the API never falls back to a folder inside the app.
  On a Mac for local development set `FILES_DIR` (e.g. `/Users/<you>/events-uploads`), because `/assets/uploads`
  doesn't exist there.
- Covers go in the purpose subfolder `events/covers/`. `file.storage_key` is the path inside `FILES_DIR`.
- Storage sits behind `clients/file-storage.client.ts` (`save`, `delete`, `url`), so a bucket can be added later
  without touching event code. `file.storage_provider` records where each file lives (`local` today).
- If the folder is missing or not writable, the upload answers 503 `file_storage_unavailable` and nothing is recorded.

### Recording

One transaction locks the event, checks its status again, inserts a `file` row (`purpose = 'EVENT_COVER'`,
`entity_type = 'EVENT'`, `entity_id` = the event, `uploaded_by` = the staff member) and sets `event.cover_file_id`.
If that transaction fails, the file just written is deleted (best effort, logged when it can't be).

Replacing or removing a cover **keeps the old file and its row**; a later clean-up job removes files no event points
at.

### Serving

`express.static` serves `FILES_DIR` at `/assets/uploads`, without login:
- `Cross-Origin-Resource-Policy: cross-origin`, so the booking site can show covers in `<img>` (helmet's default
  `same-origin` would block them);
- `Cache-Control: public, max-age=31536000, immutable`, because a name is never reused;
- `X-Content-Type-Options: nosniff`; no folder listings, no redirects for folders, no dotfiles. Anything not served
  falls through to the usual JSON 404.

### Proof (matrix rows 38–40)

- **38:** Selam's owner uploads a PNG to the published Annual Summit. One `EVENT_COVER` row is recorded. The file is
  served byte for byte with CORP `cross-origin`, and the staff event, public card and public page show the same path.
- **39:** a viewer, branch-limited staff, the owner on another tenant's path, a non-image named `.png` (415) and the
  CLOSED Banking Forum (409) are all refused, with no new file on disk and no new row.
- **40:** a JPEG replaces the cover, giving a new path. Removing the cover clears the staff and public pages. Both
  files and both rows remain for the later clean-up.

## Phase 7 step 1: checkout settings, prices and audiences (26 November 2026)

**On the event** (create and `PATCH`, `EVENTS` create or update):
- `registration_mode`: `QUICK` (the buyer gives one mobile for delivery; tickets may be unnamed) or `DETAILED` (each
  ticket holder's details are collected). Default `DETAILED`.
- `holder_fields`: for `DETAILED` events, `{ name, mobile, email, affiliation, country }`, each `REQUIRED`, `OPTIONAL`
  or `HIDDEN`, always sent together. Default: today's form (name and mobile required, the rest optional). Existing
  events got exactly that, so they behave as before.
- `purchase_limit_per_mobile`: the most tickets one buyer mobile may hold at the event, across every order; `null`
  means no limit. Stored now; enforced from step 2, when orders record the buyer's mobile.

**On a ticket type:**
- `price`: an exact decimal string (`"500"` is stored as `"500.00"`); `"0.00"` (the default) is free. One event may
  offer free and paid types.
- `currency`: the organizer's `default_currency`, copied when the type is created. It is never sent.
- `audience`: `PUBLIC` (the default) or `STAFF_ONLY` (only authorized staff may issue it).
- Existing types became free and public. General Admission is created free and public.

**Where the rules apply:**
- **The public page** lists only active `PUBLIC` types, with `price`, `currency` and `is_free`, plus the three event
  settings. `registration_open` (page and catalog card) also needs an active public type, so a staff-only type never
  makes an event look open.
- **The public form:**
  - a `STAFF_ONLY` type is 404, even by code;
  - with no public type active it is 409 `registration_closed` (`reason: NO_PUBLIC_TICKETS`);
  - a `DETAILED` event's required fields must be given and hidden ones aren't accepted (400, `issues[].code`
    `required` or `not_collected`). The form's phone is the delivery mobile, so the mobile setting doesn't apply to it.
- **Both single-ticket endpoints** refuse a paid type (409 `payment_required`). Moving a guest onto a paid type is
  refused too. Paid tickets come through checkout (steps 2–3).
- **Staff** may issue `STAFF_ONLY` types.

**Proof:** matrix rows 87–88.
