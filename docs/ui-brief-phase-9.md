# Building brief: cancelling, rescheduling and the door time (Phase 9)

Copy everything below the line into the agent. Build the Phase 8 brief first: this one uses its gate screen and Payments pages.

---

You are changing screens in **events-web** (Next.js, at `/Users/joedee/cheche-projects/Event_management/events-web`). The API is already built. Change the screens only.

## Rules

1. **Read `events-web/AGENTS.md` first and follow it exactly:**
   - this Next.js version's guide in `node_modules/next/dist/docs/`;
   - the Cheche UI library in `components/ui/`: pick components with `.cheche-ui/choosing.md`, follow `.cheche-ui/patterns.md`, and look up props in `.cheche-ui/components.md`;
   - tokens only, Lucide icons, and `toast` for results.
2. **Never edit anything in `components/ui/`.** If a component can't do what you need, stop and ask.
3. **Never touch the landing page:** `app/(home)/page.tsx`, `app/(home)/layout.tsx`, `components/marketplace/home/*`, `components/marketplace/site-footer.tsx`.
4. **Don't touch** events-api, migrations, databases or `.env` files. **Don't change git.**
5. **Stop and ask** when the API answers differently from this brief.
6. **Copy:** plain words, sentence case, no exclamation marks.
7. **Dates:** Ethiopian date and time first, then the Gregorian date with a 12-hour time. Never a 24-hour clock. Use the event's own `timezone`.
8. **Money:** use `formatCurrency` with the API's `currency`. Amounts are strings.
9. **Check** at 375 px and in dark mode; run the typecheck and lint and report the results.

## API

### The door time

- **The event** (create, update and read) has `doors_open_at`: optional, and empty means the doors open at `starts_at`. It must be before `ends_at`.
- **The public event page** also carries `doors_open_at`.
- **At the gate,** a scan before the door time or from `ends_at` on is 409 `outside_admission_window` (`details.doors_open_at`, `details.ends_at`).

### Cancelling an event

`POST /v1/organizations/{organizationId}/events/{eventId}/cancel` (*Events › update*).
- **Body** `{ refund_admitted_tickets? }`:
  - it's **required only when guests were already admitted** (the summary's `checked_in` is above 0);
  - without it the API answers 400 with `details.issues[0].code` `refund_decision_required`;
  - `true` means used paid tickets are refunded too; `false` means only unused tickets are.
- **200**: the event, with `status: "CANCELLED"`, `cancelled_at`, `cancelled_by` and `refund_admitted_tickets`.
- **What the API does by itself:**
  - stops sales and admissions;
  - releases unpaid holds and cancels every unused ticket;
  - opens one `EVENT_CANCELLATION` payment case per paid order;
  - texts every affected buyer.
- Cancelling again changes nothing. `PATCH …/status` with `CANCELLED` follows the same rules (it also takes `refund_admitted_tickets`). Allowed from DRAFT or PUBLISHED.

### Rescheduling an event

`POST /v1/organizations/{organizationId}/events/{eventId}/reschedule` (*Events › update*).
- **Body** `{ starts_at, ends_at, doors_open_at? }`: start and end always together. If the event has its own door time, **send `doors_open_at` again**: the same, a new one, or `null` to open at the start. Otherwise the API answers 400 `doors_open_at_reconfirm`.
- **409 `event_has_admissions`**: guests were already admitted, so the schedule can't move any more.
- **What the API does by itself:** tickets and codes stay valid, and buyers are texted about an actual move. Explicit sales dates (`registration_opens_at`, `registration_closes_at`) stay as they are unless staff change them.
- `PATCH …/events/{id}` date edits on a published event follow the same rules. 400 `schedule_pair_required` means only one of `starts_at` and `ends_at` was sent.

### Capacity

Lowering the event's or a ticket type's capacity below its confirmed tickets plus active holds is 409 `capacity_below_registrations`, with `details.confirmed`, `details.held` and `details.minimum`.

### Stopping a ticket type

Deactivating a ticket type (existing `PATCH …/ticket-types/{id}/status`) stops new orders for it only. Its issued tickets still work at the door and can still be returned.

## Changes

1. **Staff, the event form:**
   - Add a *Doors open* date-time field next to start and end. Hint: "Leave empty to open at the start time." Validate that it's before the end.
   - On a published event that has guests checked in, disable the start, end and doors fields, with the reason "The schedule can't change after the first guest is admitted".
2. **Staff, the event page, a *Reschedule* action** (published events, while `checked_in` is 0):
   - a dialog with start, end and doors, prefilled with the current values;
   - send all three when the event has a door time;
   - the dialog says "Tickets and codes stay valid. Buyers are sent an SMS with the new time";
   - if the event has an explicit sales cutoff earlier than the new start, show a note: "Ticket sales still close at {cutoff}. Change it under Registration if you need to."
3. **Staff, the event page, a *Cancel event* action** (DRAFT or PUBLISHED):
   - a `ConfirmDialog` that says what happens: sales and the gate stop, unused tickets are cancelled, buyers are texted, and refunds are recorded under Payments;
   - when `checked_in` is above 0, add a required choice: "Refund guests who already used their ticket?" (*Yes* or *No*), sent as `refund_admitted_tickets`;
   - after success, show the event as Cancelled and link to Payments filtered by this event (`?event_id=…&kind=EVENT_CANCELLATION`).
   - Use the new action instead of setting the status to Cancelled in the status menu, or have the status menu open this same dialog.
4. **Staff, a cancelled event:**
   - show a Cancelled banner with `cancelled_at`, and whether used tickets are refunded;
   - hide sales, check-in, return and edit actions.
5. **Buyer, the order page:**
   - fetch the public event (`GET /v1/public/organizations/{organization.slug}/events/{event.slug}`, both slugs are in the order reply);
   - when its `display_status` is `CANCELLED`, show "This event was cancelled". Cancelled tickets show no QR, and "The organizer will refund you" appears when any of them was paid;
   - always show the current start time and, when `doors_open_at` is set, "Doors open {time}". A rescheduled event simply shows its new time.
6. **Public event page:** show "Doors open {time}" when `doors_open_at` is set. A cancelled event already shows Cancelled; keep that.
7. **The gate screen (Phase 8):** before the doors open, show the scanner disabled with "Doors open at {time}". After the end, show "The event has ended".
8. **Errors in `describeApiError`:**
   - `event_has_admissions`: "The schedule can't change after the first guest is admitted."
   - `refund_decision_required`, `doors_open_at_reconfirm`, `schedule_pair_required` (issue codes): show them on the matching field. The messages are "Choose whether used tickets are refunded", "Confirm the door time", and "Change the start and end together".
   - `capacity_below_registrations`: "At least {minimum} places are taken or held."
   - `outside_admission_window`: as in the Phase 8 brief.

## When you're done

Report:
- the files you changed;
- the typecheck and lint results;
- screenshots at 375 px and in dark mode of:
  - the event form with *Doors open*;
  - the reschedule dialog;
  - the cancel dialog without and with the used-ticket choice;
  - a cancelled event (staff);
  - a buyer's order page for a cancelled event and for a rescheduled one;
  - the gate before the doors open;
- anything that didn't match the API.
