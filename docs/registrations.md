# Registrations (Phase 4)

Phase 4 adds the guest list. Staff enter guests (4a), and visitors register through the public form (4b). Both go through **one registration service**, so the rules and the capacity checks are the same everywhere. Every place taken queues a confirmation SMS, which a worker sends after the transaction commits (4c).

The source of truth is `docs/event-management-mvp1-final.md`: §6 `person`, §8 `registration`, and "Rules shared by staff and public registration". The plan is in `docs/plan/implementation-plan.md` (Phase 4).

## Permissions and menu

The `REGISTRATIONS` module covers guest profiles and registrations. Its menu item is *Event Management › Guests* (`/guests`), after Events and Clients.

| Role | Grants |
|---|---|
| `OWNER` | view, create and update |
| `VIEWER` | view, so read-only staff can use the guest list at the door |

Branch-limited staff get 403 during the organization-first pilot, as for the rest of the back office. Migrations `20261126000003` and `20261126000004` add the module and grant it to existing `OWNER` and `VIEWER` roles; new organizations get it from `src/utils/default-roles.ts`.

## 4a: guest profiles and staff registration

### Guest profiles: `person`

A guest profile is an organizer's reusable attendee profile. Each organizer keeps its own profiles. A matching name, phone or email **never** links two profiles, so separate profiles may represent the same human (the spec allows this).

| Call | Permission | Notes |
|---|---|---|
| `POST /v1/organizations/{organizationId}/persons` | `create` | `{ first_name, last_name?, email?, phone?, affiliation_name?, country?, is_active? }`. Only `first_name` is required. |
| `GET /v1/organizations/{organizationId}/persons` | `view` | `?q&is_active&page&pageSize`. `q` searches names, email and phone. An Ethiopian mobile typed as `09…` also finds the `+251…` form. |
| `GET /v1/organizations/{organizationId}/persons/{personId}` | `view` | Includes the guest's registrations in this organization, so staff can confirm a returning guest's identity before selecting the profile. |
| `PATCH /v1/organizations/{organizationId}/persons/{personId}` | `update` | Any profile field; `null` clears. |
| `PATCH /v1/organizations/{organizationId}/persons/{personId}/status` | `update` | `{ is_active }`. A deactivated guest keeps their registrations but can't be registered again (409 `person_inactive`). |

- **Phones** follow the client rule: Ethiopian mobiles are stored as `+251…`, and other numbers as typed.
- **`user_id`** is never set by staff. It is reserved for attendees who register themselves with a Central Auth account, in a later phase. It is unique per organization when present.

### Registrations: an event's guest list

| Call | Permission | Notes |
|---|---|---|
| `POST /v1/organizations/{organizationId}/events/{eventId}/registrations` | `create` | `{ person_id }` (an existing guest) **or** `{ person: {...} }` (a new guest), plus `ticket_type_id?`. |
| `GET /v1/organizations/{organizationId}/events/{eventId}/registrations` | `view` | `?status&ticket_type_id&q&page&pageSize`, newest first. |
| `GET /v1/organizations/{organizationId}/events/{eventId}/registrations/summary` | `view` | `{ capacity, confirmed, remaining, ticket_types: [{ id, code, name, is_active, capacity, confirmed, remaining }] }`. `remaining` is null where there is no limit. |
| `GET /v1/organizations/{organizationId}/events/{eventId}/registrations/{registrationId}` | `view` | |
| `PATCH /v1/organizations/{organizationId}/events/{eventId}/registrations/{registrationId}/status` | `update` | `{ status: "CANCELLED" }` frees the place. `{ status: "CONFIRMED" }` reactivates, with every registration check repeated. |

A registration reply carries: `id`, `event_id`, `code`, `status`, `source`, `registered_by`, `registered_at`, `cancelled_at`, `person { id, first_name, last_name, phone, email, affiliation_name }`, `ticket_type { id, code, name }`, `privacy_notice` (null for staff entries), `created_at` and `updated_at`.

### The rules (one service: `src/services/registration.service.ts`)

Everything happens in one transaction:

1. **Lock the event.** It must be taking registrations, or the reply is 409 `registration_closed`. `details.reason` is one of:
   - `NOT_PUBLISHED`: a draft;
   - `CANCELLED`;
   - `CLOSED`: the event is closed, or `registration_closes_at` has passed;
   - `ENDED`: `now >= ends_at`;
   - `NOT_OPEN_YET`: before `registration_opens_at`.

   This is the same rule as the public `registration_open` flag (`registrationClosedReason` in `mappers/event.mapper.ts`). **Staff follow the same rules as the public form** (spec rule 3).
2. **Lock the ticket type.** With no `ticket_type_id`, the event's only active ticket type is used. With several, the reply is 400 `ticket_type_required`, listing the codes in `details.ticket_types`. An inactive one gets 409 `ticket_type_inactive`. A ticket type of another event is not found (404), and PostgreSQL also rejects it through the composite foreign key.
3. **Find or create the guest.** An existing profile must belong to the organization and be active.
4. **Lock the guest's registration for this event**, if there is one. There is one row per guest per event:
   - `CONFIRMED` with the same ticket type: returned unchanged with **200** (a harmless repeat: no second place, no second SMS);
   - `CONFIRMED` with another ticket type: 409 `already_registered`;
   - `CANCELLED`: **reactivated** on the same row with the same code, a new `registered_at` and a new confirmation, once the capacity checks pass.
5. **Check capacity:** the event's `capacity`, then the ticket type's own limit. Only `CONFIRMED` registrations count; null means no limit. A full one gets 409 `capacity_reached`, with `details.scope` set to `EVENT` or `TICKET_TYPE`.
6. **Store the `CONFIRMED` row** with `source = STAFF`, `registered_by` set to the staff member, and a random code. A new place answers **201**.
7. **Queue the confirmation**, if the guest has an Ethiopian mobile: a `PENDING` `message_outbox` row in the same transaction (spec rule 5). It is sent in 4c.

**Lock order:** the event, then the ticket type, then the registration. Every path that changes places follows it, including cancelling and the capacity edits below. Holding the event lock serializes all registration changes of one event, so guests racing for the last place are decided one after the other; matrix row 42 proves it on PostgreSQL.

**Codes:** 8 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, which has no 0, O, 1, I or L, so a guest can read one out (for example `K7M2Q9XP`). They're unique across the platform, so a QR code can carry one later.

**Cancelling:** staff only, for `PUBLISHED` or `CLOSED` events. It frees the place. MVP 1 sends no SMS on cancel. Cancelling an *event* leaves its registrations as they are.

**Capacity edits:** lowering the event's capacity, or a ticket type's own limit, below its confirmed registrations is refused with 409 `capacity_below_registrations`, with `details.confirmed`.

### Decisions (25 November 2026)

- Staff follow the public form's rules: published, not ended, inside the window, an active ticket type and room. *Alternative, if needed later:* let staff add guests outside the window.
- One registration per guest per event: a repeat is harmless, a different ticket type is refused, and a cancelled guest is reactivated.
- Public guests always get a new, unlinked profile (4b).
- Only `CONFIRMED` registrations count, and capacities can't drop below them.
- `VIEWER` can read the guest list.

### Proof (matrix rows 41–46, `tests/integration/authorization.test.ts`)

- **41:** staff register Hana for Guest Night (capacity 2). The registration is `CONFIRMED` and `STAFF`, `registered_by` is the owner, the phone is stored as `+251…`, there's an 8-character code, and one `PENDING` SMS is queued.
- **42:** five guests race for the last place at the same time. Exactly one wins and the others get `capacity_reached`. Nothing is left behind by the losers (no registration, no profile, no SMS).
- **43:** cancelling Hana frees a place for a newcomer. Hana can't come back while the event is full. Once a place is free, she returns on the same row and code. A further repeat answers 200.
- **44:** a draft (`NOT_PUBLISHED`), the Summit's closed sign-ups (`CLOSED`), an inactive ticket type, another event's ticket type and another organization's guest are all refused. PostgreSQL rejects the last two even on a direct insert.
- **45:** a viewer reads and searches the guest list but can't register or cancel. Branch-limited staff and another tenant get 403.
- **46:** the event's capacity and GA's limit can't drop below the 2 confirmed registrations.

## 4b: public registration (no login)

### `POST /v1/public/organizations/{organizationSlug}/events/{eventSlug}/registrations`

A visitor who opens an event by link registers without an account. It uses the same registration core as staff entry, so the same rules apply: the event is taking registrations, the ticket type is active, and there is room.

- **Header:** `Idempotency-Key`, **required**: 8–128 letters, digits, `-` or `_` (a UUID works). Missing or malformed gives 400 `validation_error` at `headers.idempotency-key`.
- **Body (strict):**

  | Field | Rule |
  |---|---|
  | `first_name`, `last_name` | Required |
  | `phone` | Required, an Ethiopian mobile (stored as `+251…`), where the confirmation SMS goes. Another number gives 400. |
  | `email`, `affiliation_name`, `country` | Optional |
  | `ticket_type_code` | The code shown on the event page. Needed only when the event has several active ticket types. |
  | `privacy_notice_version` | The version of the notice the form showed, from the event page's `privacy_notice` |

- **Reply (visitor fields only):** `{ code, status, registered_at, ticket_type { code, name }, event { name, slug, starts_at, ends_at, timezone }, organization { name, slug }, guest { first_name } }`. A new registration answers **201**. The same request again answers **200**, with the same registration as it is now.
- **Refusals:**

  | Status and code | Meaning |
  |---|---|
  | 404 | The event isn't public: a draft, never published, or an inactive organization |
  | 409 `privacy_notice_outdated` | The form showed an older notice; `details.current` is the current version |
  | 409 `idempotency_key_reused` | The same key was sent with a different form |
  | 409 `registration_closed`, 409 `capacity_reached`, 400 `ticket_type_required`, 409 `ticket_type_inactive` | As for staff entry |
  | 429 `rate_limited` | More than 10 submissions a minute from one IP |

- **A new profile every time:** each visitor gets a new, unlinked guest profile. A matching name, phone or email never links two profiles, so two people may share a phone (spec §6).

### Retries: `submission_key` and `registerOnce`

Spec rule 4: return the original result when the same submission is retried. `registrationService.registerOnce` works like this:

1. **Lock the event first.** This serialises every registration change of the event, including two copies of one submission that arrive at the same moment.
2. **Look up the key.** The key is stored per organization, with a scope of `PUBLIC_REGISTRATION` or `STAFF_REGISTRATION`.
   - **The same request** (same `request_hash`: a sha256 of the event and the form, in a fixed field order): return the original registration. No new profile, place or SMS.
   - **A different request:** 409 `idempotency_key_reused`.
   - **No key yet:** register through the core, then store the key in the same transaction.

**Only a successful registration stores its key.** A refused attempt (full, closed, invalid) wrote nothing, so retrying it simply checks again; a place may have freed up meanwhile.

**Staff may send a key too**, on `POST /events/{eventId}/registrations`, where it is optional. A replay answers 200 with the message "Same request already processed". It protects "create a guest and register" from a double click.

### Privacy evidence

- **The version:** the event page returns `privacy_notice: { version }`, a platform constant, `PRIVACY_NOTICE_VERSION` in `src/config/privacy.ts`. The notice text lives in events-web, and the constant changes whenever the text does.
- **Recorded on every public registration:** `privacy_notice_version`, and `privacy_notice_shown_at` (the submission time). Staff see them as `privacy_notice` on the registration.
- **No consent yet:** the MVP form asks for no affirmative consent, so `consent_purpose`, `consent_version` and `consented_at` stay empty. A staff entry records no evidence, because staff entry is not consent.

### Proof (matrix rows 47–49)

All three rows use Partner Workshop, the UNLISTED event.
- **47:**
  - The same submission twice in a row gives 201, then 200 with the same code, and exactly one confirmation.
  - Two copies sent at the same moment with one key give one registration and one confirmation.
  - The same key with a changed form gets 409.
  - A staff POST with a key replays without a second profile.
- **48:** two separate submissions with the same phone give two profiles and two registrations.
- **49:**
  - The unlisted event registers by link, as `PUBLIC` with no `registered_by`, with the notice version and time recorded.
  - A draft and an inactive organization's event answer 404.
  - An outdated notice gets 409, and closed sign-ups get 409 `CLOSED`.
  - No profile or key is written for any refusal.

## 4c: sending confirmations

Every place taken writes a `PENDING` row to `message_outbox` in the same transaction. This happens for staff entry, the public form and reactivations, but only when the guest has an Ethiopian mobile. The **outbox worker** delivers those rows after commit. A failed delivery is retried without touching the registration, and it never takes another place.

### The message

The text is in English, with the Ethiopian date and Ethiopian-clock time first, then the Gregorian date with a 12-hour time. It's computed in the **event's own timezone** (`src/utils/confirmation-message.ts`):

> Selam Events: You're registered for Banking Forum, Megabit 3, 2019 at 3:00 in the morning (Mar 12, 2027, 9:00 AM). Your code: K7M2Q9XP

- **The calendar** is ported from `events-web/lib/calendar.ts`, with the same conversion and month spellings, so web and SMS agree (`src/utils/ethiopian-calendar.ts`).
- **The Ethiopian clock** counts from 6 AM and 6 PM:

  | Hours | Shown as |
  |---|---|
  | 6 AM to noon | "in the morning" (9:00 AM is "3:00 in the morning") |
  | Noon to 6 PM | "in the afternoon" |
  | 6 PM to midnight | "in the evening" |
  | Midnight to 6 AM | "at night" |

- **A long event name** is shortened to 60 characters with plain `...`, so the message stays within 2 SMS segments. An ellipsis character (`…`) would switch the SMS to a costlier encoding.

### Senders (`src/clients/sms/`)

| `SMS_DELIVERY` | Effect |
|---|---|
| `log` (the default) | Logs the masked phone (`+2519****4567`) and the text. **Nothing is sent.** In production the API warns about this at startup. |
| `afromessage` | Sends through Cheche's platform AfroMessage account, with the same request as bookings_api. It needs `PLATFORM_SMS_AFROMESSAGE_TOKEN`, `PLATFORM_SMS_AFROMESSAGE_FROM_ID` and `PLATFORM_SMS_SENDER`; startup refuses it without them, naming only the keys. |

- **The token** sits only in the `Authorization` header. It never appears in the URL, an error, `last_error` or a log line.
- **Another provider** (for example Raven) is one new sender implementing `send({ to, text })`, plus one case in `src/clients/sms/index.ts`.

### The worker (`src/jobs/outbox-worker.ts`, `src/services/outbox-delivery.service.ts`)

- **Start and stop:** it runs every `OUTBOX_POLL_INTERVAL_MS` (default 10 seconds) and never overlaps itself. It's started by `server.ts`, never by tests, and stopped on shutdown before the database pool closes. `OUTBOX_WORKER_ENABLED=false` turns it off.
- **Each tick:**
  1. **Claim:** it claims up to 20 due `PENDING` messages in one statement with `FOR UPDATE SKIP LOCKED`. Each claimed message gets `attempts + 1` and a **5-minute lease**, so several API instances never send the same message at once.
  2. **Caps:** more than **5 SMS to one number in an hour**, or the platform-wide **`SMS_DAILY_LIMIT`** (default 2000 in a rolling 24 hours), marks the message `SKIPPED`, with the reason in `last_error`. The registration still stands.
  3. **Send:** success marks it `SENT`, with `sent_at` and `provider_message_id`. A failure retries it after **1, 5, 15 and then 60 minutes**, and the 5th failure marks it `FAILED`.
- **Delivery is at least once.** If the process crashes after sending but before recording `SENT`, the lease expires and that SMS may go out a second time. That is the accepted trade-off: losing a confirmation would be worse.

### What staff see

Staff registration replies carry `confirmation: { status, sent_at } | null`, taken from the registration's latest message. The status is `PENDING`, `SENT`, `FAILED` or `SKIPPED`; `null` means no SMS was queued, because the guest has no Ethiopian mobile.

### Settings

| Setting | Default |
|---|---|
| `SMS_DELIVERY` | `log` |
| `PLATFORM_SMS_AFROMESSAGE_TOKEN` | — |
| `PLATFORM_SMS_AFROMESSAGE_FROM_ID` | — |
| `PLATFORM_SMS_SENDER` | — |
| `SMS_TIMEOUT_MS` | `10000` |
| `SMS_DAILY_LIMIT` | `2000` |
| `OUTBOX_WORKER_ENABLED` | `true` |
| `OUTBOX_POLL_INTERVAL_MS` | `10000` |

### Proof (matrix row 50)

The test runs with the log sender on the real database:
- The worker turns every due confirmation queued by rows 41–49 into `SENT`, each on its first attempt.
- A message still leased by "another worker" is left alone.
- A second run sends nothing.
- Staff see `confirmation.status = SENT`.

## 4d: changing a ticket type and exporting the guest list

Decided 25 November 2026. Proof: matrix rows 63–65.

### Changing a guest's ticket type

`PATCH /v1/organizations/{organizationId}/events/{eventId}/registrations/{registrationId}/ticket-type` with `{ ticket_type_id }`, needing `REGISTRATIONS.update`. The reply is 200 with the registration, and the message "Ticket type changed" or "Ticket type unchanged".

- **The same row:** the guest keeps their code and `registered_at`. No SMS goes out, because the confirmation doesn't mention the ticket type.
- **When:** PUBLISHED events only, at any time (also after sign-ups close or the event ended, at the door). Other events give `409 invalid_event_state` with `details.status`.
- **Only a CONFIRMED registration moves.** A cancelled one gives `409 registration_cancelled`: bring the guest back first.
- **The new ticket type** must belong to the event (404), be active (`409 ticket_type_inactive`) and have room under its own limit (`409 capacity_reached`, `scope: TICKET_TYPE`). The event's total doesn't change, so the event's capacity isn't checked. The ticket type the guest already has changes nothing.
- **Lock order:** the event, then both ticket types (sorted by id), then the registration. The event lock serializes every change to the event's places, so two staff can't overfill a ticket type (row 63 races two moves for the last place).

### Exporting the guest list as CSV

`GET …/events/{eventId}/registrations/export?status&ticket_type_id&q`, needing **`REGISTRATIONS.export`**: its own right, because the file holds every guest's mobile. Owners have it; Viewers and custom roles only when given it.

- **Contents:** the list's filters and order (newest first), every matching guest in one file. Paging isn't accepted (400).
- **File:** `text/csv; charset=utf-8`, UTF-8 with a byte-order mark (so Excel shows Amharic names), CRLF line ends, `Content-Disposition: attachment; filename="{event-slug}-guests.csv"`, `Cache-Control: no-store`. Errors stay JSON.
- **Columns:** Code, Status, First name, Last name, Mobile, Email, Organization, Ticket type, Signed up (Online or Added by staff), Confirmation SMS (Waiting to send, Sent, Failed, Not sent, or No mobile), then Registered (Ethiopian), Registered (Gregorian), Cancelled (Ethiopian) and Cancelled (Gregorian).
- **Dates:** in the event's time zone, Ethiopian first ("Hidar 16, 2019 at 4:30 in the morning"), then Gregorian with a 12-hour time ("Nov 25, 2026, 10:30 AM"). Never 24-hour. No date is an empty cell.
- **Safety:** a cell starting with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading `'`, so a spreadsheet can't run it as a formula. An Ethiopian mobile is written as `0911 234 567` (text in Excel, with its leading zero); other numbers go through the safety rule.
- **Code:** `src/utils/guest-csv.ts` (pure), `registrationService.exportRegistrations`, `registrationRepository.listAllByEvent` (shares its filter with the paged list).

## Phase 6: registering with a Cheche account, and My Tickets

Decided 25 November 2026. Guest accounts themselves are in `docs/authentication.md` ("Guest accounts"). Proof: matrix rows 66–70.

### Registering while signed in

The public form is the same endpoint. A signed-in guest adds `Authorization: Bearer <guest access token>`:
- **The profile:** the account's linked profile in the event's organization, found by `(organization_id, user_id)`
  (`uq_person_organization_user_id`), or created with `user_id` set. An existing linked profile is reused as it is;
  the form's details only fill a new one.
- **The mobile** is the account's (from the token, or from auth-cheche by user id), never the form's. `phone` may be
  left out when signed in; without an account it is still required (400 at `body.phone`).
- **Registering again** for the same event returns the same registration with 200 ("You're already registered for this
  event"). Another ticket type gives 409 `already_registered`, as for staff.
- **The retry key's hash includes the account,** so one account's retry can never replay another's.
- **Two registrations at the same moment** by a new guest, for two events of one organizer, make one profile: the
  insert is `ON CONFLICT DO NOTHING` and the second reads the first's profile (row 70).
- **Without a token** nothing changes: a new, unlinked profile every time.
- A deactivated linked profile can't register (`409 person_inactive`).

**Not linked (decided):** registrations made before having an account, or without signing in, stay with their unlinked
profiles. A matching mobile never links them (spec §6), so they don't appear in My Tickets; their code still works.
A guest who registered that way can register again for the same event once signed in: the two are separate profiles
until claiming is built.

### My Tickets

`GET /v1/customer/registrations` with the guest's token: every registration of every profile linked to the account,
across organizers. Upcoming and ongoing events first (soonest first), then past ones (most recent first). Each entry:
`code`, `status`, `registered_at`, `cancelled_at`, `ticket_type { code, name }`,
`event { name, slug, starts_at, ends_at, timezone, status }` and `organization { name, slug }`. No internal ids.
Registrations staff made for a linked profile also show: they're the guest's own.

Migration `20261130000000-add-person-user-id-index` adds an index on `person(user_id)` for this lookup.

## Phase 7 step 1: what changed for registrations (26 November 2026)

- The public form only offers `PUBLIC` ticket types: a `STAFF_ONLY` type is 404 even by code, and an event with no
  active public type is 409 `registration_closed` (`reason: NO_PUBLIC_TICKETS`). Staff may issue staff-only types.
- A ticket type with a price can't be issued by either single-ticket endpoint (409 `payment_required`), nor can a
  guest be moved onto one. Free tickets work as before.
- A `DETAILED` event's `holder_fields` apply to the public form (400, `required` or `not_collected`).
- Group orders, the per-mobile limit and paid checkout come in Phase 7 steps 2–3. Details in `docs/events.md`.

## Phase 7 step 2: orders and group checkout (26 November 2026)

**The model.** A registration is now one ticket. Every ticket belongs to a `ticket_order`: one buyer, one event, one
checkout. The order keeps the buyer's delivery mobile, the buyer's Cheche account when signed in, the total and the
currency; each ticket keeps its own code and its price at checkout. Existing registrations each got a free order of
their own (same id, their code as the reference). A QUICK ticket has no holder profile (`person_id` null); a DETAILED
ticket's holder becomes a new, unlinked guest profile, as the public form makes today.

**Checkout** (`src/services/checkout.service.ts`, `checkoutInTransaction`), all or nothing, under the event lock and
then the chosen ticket types in id order:
1. the event takes registrations;
2. each ticket type exists, is active and open to the caller (`STAFF_ONLY` for staff only; 404 for the public, even
   by code);
3. at most 20 tickets per order;
4. DETAILED: one holder per ticket, following `holder_fields` (400 naming `body.items.{i}.holders.{j}.{field}`);
   QUICK: no holders. A holder's other details need their first name (`required_with_details`); an event that hides
   the name can't collect anything else;
5. prices from the server; a positive total is 409 `payment_required` until step 3;
6. the event's capacity and each type's limit, for the whole order (409 `capacity_reached` with `remaining`);
7. the purchase limit: tickets the buyer mobile already holds at the event (every order, staff ones included,
   cancelled ones not) plus this order (409 `purchase_limit_reached` with `limit`, `held`, `requested`). Mobiles are
   compared in E.164, so `0911…` and `+251911…` are one buyer.
Then the order, one ticket per unit, and one SMS to the buyer (`ORDER_CONFIRMATION`) listing every code, split every
10 codes. The reply carries every code, so the buyer has them even if the SMS is late.

**Retries:** `checkoutOnce`, the `registerOnce` pattern with scopes `PUBLIC_CHECKOUT` and `STAFF_CHECKOUT`: the same
key and body return the same order and codes (200); another body with the key is 409 `idempotency_key_reused`.

**Endpoints:**
- `POST /v1/public/organizations/{orgSlug}/events/{eventSlug}/orders` (Idempotency-Key required; a guest token is
  optional). Without an account `buyer_mobile` is required; signed in, the account's verified mobile is the buyer
  mobile and the order is linked to the account. Shares the registration form's rate limit.
- `POST /v1/organizations/{organizationId}/events/{eventId}/orders` (*Guests › create*): any active type, staff-only
  included; `buyer_mobile` optional (no SMS without it).
- `GET …/orders` (`?buyer_mobile=`) and `GET …/orders/{orderId}` (*Guests › view*).

**The single-ticket endpoints keep their contracts.** Each new registration is a one-ticket, free order for the
guest's mobile; the purchase limit applies there too (and when a ticket is brought back). A cancelled unnamed ticket
can be brought back through the status endpoint with every check and no SMS.

**Guest list, CSV and My Tickets:** the guest list and CSV show unnamed tickets ("Unnamed ticket"), each entry's order
(reference and buyer mobile) and price; `q` also finds a ticket code or a buyer mobile. The CSV gained two last
columns, Order and Buyer mobile. My Tickets also lists tickets of orders the account bought while signed in.

**Proof:** matrix rows 89–92.

## Phase 7 step 3b: paid checkout through Cheche Pay v2, as bookings uses it (26 November 2026)

Paid checkout follows the bookings project's **Cheche Pay v2** integration. Every payment is confirmed with Cheche Pay
itself, so it can't be faked. (Step 3 first used Cheche Pay's legacy API, with a service code and an unsigned callback;
3b replaced it.)

**The money goes to the organizer.** Each organizer has its own Cheche Pay secret key (`sk_test_…` or `sk_live_…`).
- Only the Super Admin manages it, at platform scope: `GET`, `PUT`, `DELETE /v1/organizations/{id}/cheche-pay` and
  `POST …/cheche-pay/check`. An Owner can't change it.
- `PUT` takes `{ secret_key?, webhook_secret?, is_active? }`:
  - `secret_key` is required the first time, and a `pk_` key is refused;
  - `webhook_secret` set to `null` clears it;
  - `is_active` set to `false` stops new payments, but payments already started can still be confirmed.
- The keys are stored encrypted (AES-256-GCM with `CHECHE_PAY_CREDENTIALS_KEY`) and are never returned. The reply
  shows the mode, the last 4 characters (`sk_test_••••ab12`), whether a webhook secret is saved, the `webhook_url` to
  give Cheche Pay, and `paid_sales_available`.
- **There is no platform key.** An organizer without active keys can't sell paid tickets: 409
  `paid_sales_unavailable`, with `reason` `NO_CHECHE_PAY_KEYS`. When the server isn't set up for Cheche Pay, the
  reason is `CHECHE_PAY_NOT_CONFIGURED`. Online payment is in ETB only.

**A paid order** (a positive total, from the server's prices):
1. **Checkout holds every place.**
   - Tickets are `HELD` with no code, and the order is `PENDING_PAYMENT` until `hold_expires_at`
     (`PAYMENT_HOLD_MINUTES`, default 15).
   - Holds count toward the event's and each type's capacity and the buyer's purchase limit.
   - An `order_payment` row (`INITIATED`) records the exact amount.
   - A paid order needs a buyer mobile.
2. **After the transaction commits, the server starts a payment attempt.**
   - It calls `POST {finance}/transactions/initialize` with the organizer's key, the amount, ETB, the buyer's phone
     and a fresh `tx_ref` (`<payment id>-<suffix>`; Cheche Pay refuses a reused one).
   - It also sends `return_url` (`PAYMENT_RETURN_URL` + `/orders/{reference}`) and `callback_url`
     (`PUBLIC_API_BASE_URL` + `/v1/payments/cheche/webhook/{organizationId}`). A localhost or private address is left
     out, because Cheche Pay refuses the whole call.
   - The reply carries `payment.checkout_url` and an `order_token`.
3. **"Pay now"** (`POST /v1/public/orders/{reference}/payment`):
   - an unexpired checkout link is reused;
   - otherwise the last attempt is checked with Cheche Pay first, so a buyer who already paid isn't charged twice;
   - then a new attempt starts.
4. **Confirming a payment** happens in one place. Cheche Pay's webhook and the buyer's return
   (`POST /v1/public/orders/{reference}/check` with the order token) are only triggers. Either way, the server asks
   `merchant-verify/{tx_ref}` with the organizer's key:

   | merchant-verify says | What happens |
   |---|---|
   | anything but `SUCCEEDED`, or an unknown `tx_ref` | Nothing changes; the hold lapses on its own time. |
   | another currency | 409. |
   | `SUCCEEDED` for another amount | The payment becomes `MISMATCH`, kept for review. Nothing is issued. |
   | the same `tx_ref` again | A duplicate. Nothing changes. |
   | a second attempt that also succeeded | `review_reason: "PAID_TWICE"`, noted on the payment for a refund. |
   | otherwise | The payment becomes `PAID` (with `paid_tx_ref` and `verified_at`), and the tickets are issued. |
5. **The webhook** (`POST /v1/payments/cheche/webhook/{organizationId}`, no login, rate limited per IP):
   - when the organizer's webhook secret is saved, `X-Cheche-Signature` must be the hex HMAC-SHA256 of the raw body;
     otherwise it's 401 `invalid_signature`;
   - events other than `payment.*`, and other systems' `tx_ref`s, are acknowledged and ignored;
   - a payment that belongs to another organizer is 409.
6. **Issuing** runs under the event lock, then the order and payment locks. The held tickets become `CONFIRMED` with
   codes, the order becomes `CONFIRMED`, and one SMS lists the codes. The codes are on the order page as soon as the
   payment is confirmed, whether or not the SMS has gone.
7. **Release:** an unpaid hold past its time releases the places (tickets `RELEASED`, order `EXPIRED`) and gives the
   purchase allowance back. This happens inside every checkout and in the payment worker.
8. **A late payment** (after its places were released) takes them again if there is still room and the buyer is
   within the limit. Otherwise the order becomes `REFUND_REQUIRED`, with its payment kept for follow-up. It never
   oversells, and refunds themselves are out of scope.

**Staff** may create a paid order (with a buyer mobile) and share its checkout link and order token with the buyer.

**Tickets that aren't issued** (`HELD`, `RELEASED`) stay out of the guest list, the CSV and My Tickets. The status
endpoint refuses them (409 `ticket_not_issued`), and a cancelled paid ticket can't come back for free
(`payment_required`).

**The code:**
- `src/clients/cheche-pay.client.ts`: `initialize`, `verify`, `checkKey`, `verifySignature`. Failures are 502
  `payment_provider_unavailable`, and the key never appears in a log or an error.
- `src/utils/secret-box.ts`: the encryption.
- `src/services/cheche-pay-credential.service.ts`: the keys.
- `src/services/payment.service.ts`: `startPayment`, `settle`, `handleWebhook`, `checkPayment`, and the worker.

| Setting | Default |
|---|---|
| `CHECHE_PAY_FINANCE_BASE_URL` | none (paid sales off); Cheche Pay's v2 API base |
| `CHECHE_PAY_CREDENTIALS_KEY` | none (paid sales off); 32 bytes as 64 hex characters or base64. Changing it makes saved keys unreadable. |
| `PAYMENT_RETURN_URL` | none; the website's base address |
| `PUBLIC_API_BASE_URL` | none; this API's public address, for Cheche Pay's callback |
| `CHECHE_PAY_TIMEOUT_MS` | `45000` (Cheche Pay often takes 15–25 s under load) |
| `PAYMENT_HOLD_MINUTES` | `15` |
| `PAYMENT_WORKER_ENABLED` | `true` |
| `PAYMENT_POLL_INTERVAL_MS` | `60000` |

**Proof:** matrix rows 93–95, with the Cheche Pay client stubbed. Step 4 checks it against Cheche Pay itself.

## Phase 8: the physical-event pilot (27 November 2026)

### Step 1: the mobile limit on capped events

When an event sets `purchase_limit_per_mobile`, **every path that takes a place needs a buyer mobile**. Each
ticket then counts against a normalized Ethiopian number:
- staff and public checkout;
- staff and public single registration;
- bringing a ticket back through the status route.

Signed-in buyers use their account's verified mobile. Tickets and active holds are added up across ticket types, orders
and channels for the same number (`0913…`, `+251913…` and `0913 …` are one buyer). On a capped event, a request
without a usable mobile is 400 `validation_error` with issue code `buyer_mobile_required`. The issue's `path` names the
field: `body.buyer_mobile`, `body.person_id`, `body.person.phone`, `body.phone`, or `registration` for reactivation. A
guest whose only phone isn't an Ethiopian mobile counts as having none.

**Uncapped events don't change:** staff may still issue a free order without a mobile.

**Proof:** unit tests for each path, and matrix row 96. The tests were written first: only the free staff order, the
staff registration of a guest without an Ethiopian mobile, and bringing back an unnamed ticket whose order had no
mobile failed the rule. Only those three paths were changed (`ticketing.assertBuyerAllowance`).

### Step 2: the ticket QR and admission at the door

**The QR payload is the ticket's existing 8-character `code`, and nothing else.** It's already in the order page, My
Tickets and staff reads for every confirmed ticket. events-web draws, shares and downloads one QR per ticket. A friend
given one QR can't see the rest of the order, because the order token is never in it. A saved screenshot works offline;
the gate validates online.

**Admission:** `POST /v1/organizations/{organizationId}/events/{eventId}/check-ins` (Guests › update), with an
`Idempotency-Key` header and a body of `{ code }`. A scan and a typed code use the same call.
- Only a `CONFIRMED` ticket of this organization and event is admitted, once for the whole event. Admission records
  the staff member and the time in `ticket_admission`; the registration and its place don't change.
- `ADMITTED`: this request admitted the ticket. Retrying the same request (the same key) after a lost response returns
  this original result.
- `ALREADY_CHECKED_IN`: a separate scan of an admitted ticket. It carries the original time and staff member.
- **Refusals:**
  - an unknown code, or one from another event or organization: 404;
  - a ticket that is `HELD`, `RELEASED` or `CANCELLED`: 409 `ticket_not_admissible`;
  - an event that isn't `PUBLISHED`: 409 `invalid_event_state`;
  - a key that already admitted another ticket: 409 `idempotency_key_reused`.
- **Atomic:** the registration row is locked. It's the only lock check-in takes, so it can't deadlock with a return or
  a cancellation. One admission per ticket is a unique key, so two gates racing produce exactly one admission.

**Reporting:**
- the summary has `checked_in`, overall and per ticket type;
- guest-list rows and a single registration have `checked_in_at` and `checked_in_by`, with a `checked_in=true|false`
  filter;
- the CSV's last two columns are Checked in (Ethiopian) and (Gregorian).

Looking a ticket up (the guest list's `q` finds a code) and showing a QR never write anything.

**Proof:** unit tests (results, retries, refusals, the race fallback) and matrix rows 97–98 (the exact payload on
every path, two gates racing, the retried winner, a second ticket of the same order, refusals, tenants, view-only).

### Step 3: payment cases and the Payments module

**A payment case** is a money issue staff resolve by hand through the organizer's own Cheche Pay merchant account. The
API records what was done; it never moves money.

| Kind | Opened when | Identified by | `amount` |
|---|---|---|---|
| `REFUND_REQUIRED` | A payment was verified after its places were released and none were left (the order is `REFUND_REQUIRED`) | the paying attempt's `tx_ref` | the order total |
| `PAID_TWICE` | A second attempt of an already-paid order also succeeded | the second attempt's `tx_ref` | what Cheche Pay verified |
| `AMOUNT_MISMATCH` | Cheche Pay verified another amount than the order's: investigate | that attempt's `tx_ref` | what Cheche Pay verified |
| `TICKET_RETURN` | A paid ticket was returned (Step 4) | the ticket | its stored checkout price |

**One case per issue.** A case is opened in the same transaction that finds the issue (`paymentService.settle`, or the
return). It's keyed by its payment attempt or its returned ticket, so:
- two issues on one order are tracked separately;
- a repeated webhook, buyer check or return opens no second case.

Cases that existed before this step (late payments, mismatches, double-charge notes) were backfilled by migration
`20261208000005`.

**The Payments module** (`PAYMENTS`, shown as *Event Management › Payments*). Owners hold every action by default;
Viewers have none. It's separate from Guests, so door staff who check people in can't record refunds.
- `GET /v1/organizations/{id}/payment-cases?status&kind&event_id&page&pageSize`, Payments › view.
- `GET …/payment-cases/{caseId}`, Payments › view: the case, its order (status, buyer, total, tickets with codes), the
  payment (current and paid `tx_ref`, status, `verified_at`, the last verification and error) and, for a return, the
  ticket.
- `POST …/payment-cases/{caseId}/resolve`, Payments › update. It locks the case and records the outcome, the staff
  member and the time:
  - `REFUNDED`: `refunded_amount`, `refunded_currency` and `merchant_reference` (the refund reference from the
    organizer's merchant account);
  - `CLOSED_WITHOUT_REFUND`: a `note` saying why.

  Resolving again with the same outcome changes nothing; a different outcome is 409 `payment_case_already_resolved`.
  **Resolving never touches tickets or orders:** closing a double charge keeps the tickets issued for the original
  valid charge, and a late order stays `REFUND_REQUIRED`.

**Proof:** unit tests (one case per attempt or ticket, a lost race, resolutions and repeats, tenants) and matrix row 99
(a double charge, a late payment with the places sold, and a mismatch, each opening one case; resolving; the ticket
states; another organization and Viewers refused).
