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
