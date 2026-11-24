# Event management SaaS — MVP 1 product and schema specification

Final design · 23 November 2026

MVP 1 lets an organization publish physical events and manage one guest list for free registrations entered by staff or submitted through a public form. An organizer can host its own event or manage one for a client. Visitors can discover events through the public catalog or open an event link directly.

## Agreed product decisions

| Area | MVP 1 decision |
|---|---|
| Agency clients | An agency can record an organization or an individual as the client commissioning an event. Organizations remain the paying tenants. |
| Returning guests | Keep the organizer’s `person` table. Reuse a profile for a verified attendee registering themselves or when authorized staff confirm a guest’s identity. Self-service claiming of earlier registrations is deferred. |
| Public browsing | Launch with a public catalog, event covers and categories. Published public events appear in the catalog. Organizers can also publish unlisted events and share their links. |

## The eight business tables

Each table has a UUID `id` and timestamps `created_at` and `updated_at`. Tables 2–8 also require `organization_id`. The field lists below show the remaining columns. Existing platform audit conventions still apply.

### 1. `organization` — the paying organizer

The organizer record stores `name`, `slug`, `country`, `timezone`, `default_currency` and `is_active`.

One row identifies the tenant. Its globally unique `slug` forms the organizer part of public event URLs. The organization supplies defaults such as time zone and currency. The pilot focuses on organizers working at organization level.

### 2. `branch` — an organizer’s office

Each office has a `code`, `name`, `is_default` and `is_active`.

A branch belongs to one organization and its `code` is unique within that organization. A default branch can exist at setup. An event with `branch_id = NULL` is still organization-wide. An event with a branch ID has exactly one owning branch. The first-release event form can create an organization-wide event without asking the organizer to choose a branch.

### 3. `customer_account` — the client commissioning the event

The client record stores `name`, `kind`, `type`, `primary_contact_name`, `primary_contact_email`, `primary_contact_phone` and `is_active`.

`kind` accepts `ORGANIZATION` or `INDIVIDUAL` and defaults to `ORGANIZATION`. The optional `type` describes an organizational client’s sector, such as corporate, NGO or government. It is empty for an individual. An agency can record ABC Bank for a conference or Hana Bekele for a wedding. An agency running its own networking night leaves `event.customer_account_id` empty.

### 4. `venue` — a reusable physical location

Each venue has a `name` and `is_active` flag, with optional `address`, `city`, `country` and `capacity`.

An organizer can reuse a venue across events. `event.venue_id` can be empty while the location is being arranged. `venue.capacity` describes the place. `event.capacity` sets the booking limit for a particular event there. Physical events are the agreed scope for MVP 1. Online and hybrid locations are deferred.

### 5. `event` — one event hosted by the organizer

Each event stores `branch_id`, `customer_account_id`, `venue_id`, `name`, `slug`, `description`, `starts_at`, `ends_at`, `timezone`, `status`, `capacity`, `registration_opens_at` and `registration_closes_at`. Its catalog fields are `visibility`, `cover_file_id` and `category`.

All three links to branch, client and venue are optional. The `slug` is unique within the organization, so a public URL can use both slugs, for example `/selam-events/banking-forum`.

Store `DRAFT`, `PUBLISHED`, `CLOSED` or `CANCELLED`. Display **Live** for a published event while `starts_at <= now < ends_at`. A cancelled event still displays **Cancelled** during its scheduled hours.

The launch catalog lists events with `status = PUBLISHED` and `visibility = PUBLIC`. A published `UNLISTED` event stays out of the catalog and is accessible by direct link. `cover_file_id` identifies the event’s cover image and `category` describes the event for browsing. For either visibility, registration remains subject to the registration window, ticket availability and capacity.

### 6. `person` — a reusable attendee profile

The attendee profile stores `first_name`, `last_name`, `email`, `phone`, `affiliation_name`, `country`, `is_active` and a nullable `user_id`.

One organizer can reuse a known attendee across events, including a guest who has never signed in. A linked Central Auth `user_id` identifies an attendee registering for themselves. Allow at most one profile per `(organization_id, user_id)` for a non-null user ID. Each organizer keeps its own profile. A future **My Tickets** view could use the attendee’s verified account to retrieve their own registrations across organizers.

| Registration situation | MVP 1 behavior |
|---|---|
| Signed-in attendee registering themselves | Find or create their profile in the event’s organization using their verified Central Auth `user_id`. |
| Public guest without a verified account link | Create an unlinked guest profile for a new submission. A matching name, email or phone alone never links two profiles. A retry of the same submission returns the original registration. |
| Staff recognize a returning guest | Authorized staff can find a profile within their organization, confirm the guest’s identity and select it. Staff can create a profile if they cannot confirm a match. |

Staff can reuse a confirmed guest profile in MVP 1. Guests can register without an account, including when they share a phone or email with someone else. Separate guest profiles may therefore represent the same human. Unique-profile counts can exceed the number of distinct people.

### 7. `ticket_type` — a free registration category for one event

Each ticket type has an `event_id`, `code`, `name`, optional `capacity`, `display_order` and `is_active`.

The code is unique within the event. **General Admission** is the default so an organizer can open registration without configuring categories. Organizers can also offer categories such as Speaker or VIP. Each category can have its own capacity within the event’s overall limit. Paid ticketing is planned for a later release.

### 8. `registration` — one known guest’s place at one event

Each registration stores `event_id`, `person_id`, `ticket_type_id`, `status`, `source`, `registered_by`, `registered_at`, `cancelled_at` and a unique random `code`. It also records the privacy-notice and consent evidence described below.

`person_id` identifies the attendee and is required for both entry paths. `source` is `STAFF` or `PUBLIC`. For staff entry, `registered_by` identifies the staff member who entered the registration. For public entry it is empty.

Use `CONFIRMED` and `CANCELLED`. Keep one row per `(organization_id, event_id, person_id)`. Cancellation frees the place. If that known person registers again, recheck capacity and reactivate the existing registration. The random `code` identifies the registration in confirmations and can later be encoded in a QR ticket. Door scanning and check-in are deferred.

Record the privacy notice version shown and when it was shown. Where the form asks for affirmative consent, record its purpose, version and timestamp separately. A staff-entered registration alone supplies no evidence that the attendee consented.

## Rules shared by staff and public registration

1. **Enforce tenant isolation** with tenant-scoped references to branch, client, venue, person and event. Each parent referenced through `(organization_id, id)` has a corresponding unique key. Optional links also enforce the tenant match whenever an ID is present.
2. **Require the ticket type to belong to the event.** Give `ticket_type` a unique key on `(organization_id, event_id, id)`. The foreign key from `registration` uses `(organization_id, event_id, ticket_type_id)`. A ticket type from another event is rejected even if the organizer runs both events.
3. **Check capacity in one transaction.** Both entry paths use the same registration service. Lock the event first and then its ticket type. Check publication status, registration dates, ticket availability and both capacity limits before confirming or reactivating a registration. Only `CONFIRMED` registrations consume places. Apply the same lock order to capacity-changing paths.
4. **Return the original result when the same submission is retried.** This also applies to a public guest whose phone or email could be shared. A new independent submission is a different operation.
5. **Queue the confirmation when the registration is saved.** The registration service writes a pending confirmation message in the same transaction. An outbox worker delivers the email or SMS after commit and can retry a failed delivery without allocating another seat. The outbox is supporting infrastructure outside the eight business tables.

## Example across two events

Selam Events publishes ABC Bank’s March forum as `PUBLIC`. Hana finds its cover and category in the catalog and registers for General Admission. In June, Selam runs its own `UNLISTED` workshop and shares the event link directly. A coordinator confirms that Hana is the same guest and selects her existing profile when registering her as a Speaker.

Selam now has one attendee profile and two registrations. Each registration has its own event, ticket type, status and confirmation code. Cancelling the June registration frees one Speaker place at the workshop and preserves Hana’s March registration. If Hana later hires Selam to organize her wedding, Selam can identify her separately as the `INDIVIDUAL` client commissioning that event.

## Later phases

Paid checkout, QR scanning and door check-in, online or hybrid events, self-service claiming of earlier guest registrations, and a cross-organizer **My Tickets** view are deferred. MVP 1 already issues confirmation codes and supports an optional Central Auth link for an attendee.
