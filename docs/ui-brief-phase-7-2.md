# Building brief: group checkout and orders (Phase 7, step 2)

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
8. **Money:** use `formatCurrency` with the `currency` the API returns. Amounts are strings such as `"500.00"`.
9. **Check** at 375 px and in dark mode; run the typecheck and lint and report the results.

## API

| Call | What it does |
|---|---|
| `POST /v1/public/organizations/{orgSlug}/events/{eventSlug}/orders` | **Public checkout.** Header `Idempotency-Key` is required: make a new UUID when the form opens, and reuse it for retries of that submission. Body: `{ buyer_mobile?, privacy_notice_version, items: [{ ticket_type_code, quantity, holders? }] }`. `buyer_mobile` is required unless the guest is signed in (send their access token; their account's mobile is used). **201** `{ reference, status, total_amount, currency, event, organization, tickets: [{ code, status, ticket_type, price, holder }] }`. **200** means the same submission again: show the same tickets. |
| `POST /v1/organizations/{organizationId}/events/{eventId}/orders` | **Staff "Issue tickets".** `{ buyer_mobile?, items: [{ ticket_type_id, quantity, holders? }] }` with an optional `Idempotency-Key`. Staff-only types are allowed. **201** with the order: `{ id, reference, buyer_mobile, total_amount, currency, ticket_count, tickets: [{ id, code, status, ticket_type, price, holder }], confirmation }`. |
| `GET …/events/{eventId}/orders?buyer_mobile&page&pageSize`, `GET …/orders/{orderId}` | The event's orders, and one order with its tickets. Needs *Guests › view*. |
| Guest list `GET …/registrations` | Each entry now has `order: { id, reference, buyer_mobile }` and `price`. `person` is **null** for an unnamed ticket. `q` also finds a ticket code or a buyer's mobile. |

**Holders:**
- On a Detailed event (`registration_mode` on the public page), send one holder per ticket: `{ first_name?, last_name?, phone?, email?, affiliation_name?, country? }`.
- Follow `holder_fields`: show Required fields as required, Optional ones as optional, and leave Hidden ones out.
- On a Quick event, send no holders at all.

**At most 20 tickets per order**, and each ticket type appears once.

**Errors:**

| Code | Text |
|---|---|
| 400 with `issues[].path` like `body.items.0.holders.2.affiliation_name` | Show it on that holder's field: "Ticket 3: enter their organization or affiliation". `required_with_details` means "Give this guest's first name too." |
| 409 `purchase_limit_reached` (`details.limit`, `held`, `requested`) | "This mobile number can get {limit − held} more ticket(s) for this event." When that is 0: "This mobile number has reached the limit for this event." |
| 409 `capacity_reached` (`details.remaining`) | "Only {remaining} place(s) left." |
| 409 `payment_required` | "Paid tickets will be available soon." (Paid checkout comes in the next step.) |
| 409 `registration_closed` | As before. |

## Changes

1. **Public event page, the ticket form** (not the landing page):
   - Replace the single-guest form with checkout: a quantity stepper per ticket type (0 to 20 in total; free types only for now).
   - Ask for the mobile number when the guest isn't signed in.
   - On a Detailed event, a card per ticket ("Ticket 1 · General Admission") with the holder fields.
   - Show the privacy notice as today.
2. **After checkout**, a confirmation page:
   - the order reference and every ticket code, each with its ticket type and holder name (or "Unnamed ticket");
   - the line: "We've also sent the codes by SMS to 0911 234 567." If the SMS is late, the codes on screen are what matter.
   - A signed-in guest also gets a link to My Tickets.
3. **Staff, the event's Guests page:**
   - An **Issue tickets** action, as a full page (`RecordForm`), with the same ticket and holder rules, staff-only types included, and an optional buyer mobile.
   - On success, go to the order.
4. **Staff, orders:**
   - An **Orders** tab on the event (reference, buyer mobile, tickets, total, created) and an order page listing its tickets.
   - In the guest list:
     - unnamed tickets show "Unnamed ticket" with the buyer's mobile;
     - every row links to its order.

## When you're done

Report:
- the files you changed;
- the typecheck and lint results;
- screenshots at 375 px and in dark mode of:
  - the public quantity picker;
  - the Detailed holder cards;
  - the confirmation page with several codes;
  - staff "Issue tickets";
  - the Orders tab;
- anything that didn't match the API.
