# Building brief: ticket QR codes, the gate, returns and payment cases (Phase 8)

Copy everything below the line into the agent.

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
7. **Dates:** Ethiopian date and time first, then the Gregorian date with a 12-hour time. Never a 24-hour clock.
8. **Money:** use `formatCurrency` with the API's `currency`. Amounts are strings.
9. **Never log or show the order token**, and never put it in a QR code.
10. **Check** at 375 px and in dark mode; run the typecheck and lint and report the results.

## API

### Ticket QR codes

**The QR payload is the ticket's `code`, and nothing else.** That's the 8-character code already in these replies, for every confirmed ticket:
- the order page: `GET /v1/public/orders/{reference}` with `X-Order-Token`, and the replies to `/check` and `/payment`;
- My Tickets: `GET /v1/customer/registrations`;
- the staff order: `GET …/events/{eventId}/orders/{orderId}`.

A held or released ticket has `code: null` and no QR.

**Bookings already draws QR codes:** use the same QR library and settings that events-web's sister project uses for its booking codes. If you can't find them, ask before picking a library.

### The gate

`POST /v1/organizations/{organizationId}/events/{eventId}/check-ins` (staff with *Guests › update*).
- **Request:**
  - Header `Idempotency-Key`: a new random UUID per scan. **Resend the same key when retrying after a network error**: the API then returns the original result instead of "already checked in".
  - Body: `{ code }`. The scanned text or a typed code; lower case and spaces are fine.
- **200** `{ result, checked_in_at, checked_in_by, ticket: { id, code, ticket_type: { code, name }, holder: { first_name, last_name } | null, order: { reference } } }`:
  - `result: "ADMITTED"`: let them in;
  - `result: "ALREADY_CHECKED_IN"`: this ticket was used at `checked_in_at`. **Don't let them in.**
- **Errors:**
  - 404: no ticket with this code at this event;
  - 409 `ticket_not_admissible`: cancelled, returned or unpaid (`details.status`);
  - 409 `invalid_event_state`: the event isn't published;
  - 409 `outside_admission_window`: before the doors open or after the end (Phase 9, `details.doors_open_at`, `ends_at`).

**Show "Admitted" only after the API says `ADMITTED`.** The gate needs to be online.

### Attendance

- `GET …/registrations/summary` gains `checked_in`, overall and in each `ticket_types[]` entry.
- Guest-list rows and `GET …/registrations/{id}` gain `checked_in_at` and `checked_in_by` (null until admitted). The list takes `?checked_in=true|false`.
- The CSV export gains two last columns, Checked in (Ethiopian) and (Gregorian). Nothing to change on screen.

### Returning one ticket

`POST …/events/{eventId}/registrations/{registrationId}/return` (staff with *Guests › update*, no body).
- **200** `{ outcome: "RETURNED" | "ALREADY_RETURNED", registration, refund_case }`. `refund_case` is `null` for a free ticket; for a paid one it's the payment case for the refund (`kind: "TICKET_RETURN"`, `amount`, `currency`).
- **Errors:**
  - 409 `ticket_already_used`: admitted at the door (`details.checked_in_at`);
  - 409 `ticket_not_issued`: held or released;
  - 409 `invalid_event_state`.
- The existing *Cancel* on a guest now behaves the same: it refuses a used ticket and opens the refund case for a paid one.

### Payment cases (the Payments module)

The menu item *Event Management › Payments* (`/payments`) appears in `/me` for Owners; Viewers and door staff don't get it. Use the `PAYMENTS` permission (`view`, `update`) to show or hide controls.

| Call | What it does |
|---|---|
| `GET /v1/organizations/{organizationId}/payment-cases?status&kind&event_id&page&pageSize` | The list, newest first. Each case: `{ id, event_id, order_id, kind, tx_ref, registration_id, amount, currency, status, resolution, created_by, created_at }`. |
| `GET …/payment-cases/{caseId}` | One case, plus `order` (reference, status, buyer_mobile, total, tickets with codes and statuses), `payment` (`current_tx_ref`, `paid_tx_ref`, status, amount, `verified_at`, `last_error`), and `ticket` (a returned ticket). |
| `POST …/payment-cases/{caseId}/resolve` | `{ resolution: "REFUNDED", refunded_amount, refunded_currency, merchant_reference }` or `{ resolution: "CLOSED_WITHOUT_REFUND", note }`. 409 `payment_case_already_resolved` if another outcome was recorded. |

**Case kinds, for labels:**
- `REFUND_REQUIRED`: "Paid too late: refund";
- `PAID_TWICE`: "Charged twice: refund one";
- `AMOUNT_MISMATCH`: "Wrong amount: investigate";
- `TICKET_RETURN`: "Returned ticket: refund";
- `EVENT_CANCELLATION`: "Event cancelled: refund" (Phase 9).

The money is moved by hand in the organizer's Cheche Pay merchant account; this screen only records it.

## Changes

1. **Buyer, the order page and My Tickets:**
   - Show a QR next to each confirmed ticket's code. Each QR gets its own *Download* (PNG) and *Share* (the device share sheet, where available), so a buyer can pass one ticket to a friend.
   - A held, released or cancelled ticket shows no QR.
   - The saved image must still scan: give it a quiet margin and a size of at least about 240 px.
2. **Staff, a gate screen** (from the event page, e.g. *Check in guests*):
   - a camera scanner and a code field, both calling the same check-in;
   - after each scan, a large result card:
     - *Admitted* (success colour) with the ticket type and holder name, or "Unnamed ticket";
     - *Already checked in at {time}* (warning colour);
     - the error message (danger colour);
   - keep the last few results in a list;
   - retry with the same `Idempotency-Key` on a network error.
3. **Staff, the guest list:**
   - a *Checked in* column (a `StatusPill` with the time on hover or in the row details);
   - a *Checked in / Not yet* filter;
   - the summary card shows "{checked_in} checked in".
4. **Staff, a guest or order:**
   - a *Return ticket* action on each confirmed ticket, behind a `ConfirmDialog`. The dialog says it frees the place and, for a paid ticket, "A refund of {amount} will be due".
   - After it succeeds, show the refund case's amount and a link to it under Payments.
   - Hide the action for a used ticket, or show it disabled with "Already used at the door".
5. **Staff, Payments** (`/payments`, only with *Payments › view*):
   - **The list:** filters for status (default *Open*), kind and event; columns for kind label, amount, order reference, created, status.
   - **The detail:**
     - the order and its tickets, and the payment references (`tx_ref`, `paid_tx_ref`);
     - a *Record outcome* form, only with *Payments › update*: *Refunded* (amount, currency default ETB, merchant reference) or *Closed without refund* (note);
     - once resolved, show the outcome, who and when.
6. **Errors in `describeApiError`:**
   - `ticket_not_admissible`: "This ticket can't be used: {status}."
   - `ticket_already_used`: "This ticket was already used at the door."
   - `payment_case_already_resolved`: "This case was already closed with a different outcome."
   - `outside_admission_window`: "Doors aren't open yet" or "The event has ended", chosen by comparing now with `details.ends_at`.
   - `buyer_mobile_required` (an issue code): "This event limits tickets per mobile number: add the buyer's Ethiopian mobile."

## When you're done

Report:
- the files you changed;
- the typecheck and lint results;
- screenshots at 375 px and in dark mode of:
  - an order page with QR codes;
  - the gate after an *Admitted* scan and after an *Already checked in* scan;
  - the guest list with the checked-in column;
  - the return dialog;
  - the Payments list and a case detail;
- a check that a downloaded QR image scans back to exactly the ticket code;
- anything that didn't match the API.
