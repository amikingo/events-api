# Building brief: paying for tickets (Phase 7, step 3)

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
8. **Money:** use `formatCurrency` with the API's `currency`. Amounts are strings. The server works out every price: never send one.
9. **Never log or show the order token** except where this brief says to keep it.
10. **Check** at 375 px and in dark mode; run the typecheck and lint and report the results.

## API

Payments go through **Cheche Pay**. Each organizer has payment options (such as Telebirr); the buyer picks one.

| Call | What it does |
|---|---|
| `GET /v1/public/organizations/{orgSlug}/events/{eventSlug}/payment-options` | The organizer's payment options: `[{ id, name }]`. An empty list means paid tickets can't be bought online for this event. |
| `POST /v1/public/organizations/{orgSlug}/events/{eventSlug}/orders` | Same checkout as step 2. A paid order also sends **`payment_option_id`** (the chosen option's `id`). It answers **201** with `status: "PENDING_PAYMENT"`, `hold_expires_at`, `payment: { status, checkout_url }`, tickets with `code: null` and `status: "HELD"`, and `order_token`. **409 `paid_sales_unavailable`**: the organizer can't sell paid tickets yet. **400** with `details.issues[0].code` `unknown_payment_option` (reload the options) or `required` on `body.payment_option_id` (none chosen). |
| `GET /v1/public/orders/{reference}` | **The order page.** Header `X-Order-Token: {order_token}`. Status, payment link, and every ticket code once paid. A wrong token is 404. |
| `POST /v1/public/orders/{reference}/payment` | Header `X-Order-Token`. Starts or resumes paying and returns the order with `payment.checkout_url`. **502 `payment_provider_unavailable`**: try again. **409 `invalid_order_state`**: the order isn't waiting for payment. |
| `POST /v1/organizations/{organizationId}/events/{eventId}/orders` | Staff checkout, as in step 2. A paid order also needs `buyer_mobile` and `payment_option_id`, and answers with `payment.checkout_url` and `order_token` once. |
| `GET`, `PUT /v1/organizations/{organizationId}/cheche-pay-service` | **Super Admin only.** `PUT { cheche_pay_service }` (the organizer's Cheche Pay service code, e.g. `SELAM`; `null` turns paid sales off). The reply has `cheche_pay_service`, `payment_options [{ id, name }]`, `paid_sales_available` and `warnings [{ code, message }]`. |

Cheche Pay tells the server when the buyer has paid. There is no "check payment" call: the website reloads the order page.

**Order statuses:**
- `PENDING_PAYMENT`: "Waiting for payment"; the places are held until `hold_expires_at`.
- `CONFIRMED`: "Paid".
- `EXPIRED`: "Not paid in time".
- `REFUND_REQUIRED`: "Paid after the places were released. The organizer will refund you."

## Changes

1. **Public checkout:**
   - Paid ticket types can now be chosen, and the form shows the total.
   - When the total is above zero, load the payment options and show them as a required choice (a radio group, with each option's `name`). If the list is empty, show "Paid tickets aren't available online for this event" and disable paying.
   - After a `PENDING_PAYMENT` reply:
     - keep `{ reference, order_token }` in the browser's local storage, keyed by reference;
     - show the order page link ("Come back to this page after paying"), then send the buyer to `payment.checkout_url`.
   - If `checkout_url` is null, show "Preparing your payment…" and call `/payment` again, at most 3 times.
2. **Order page** (`/orders/{reference}`):
   - Read the token from storage, then `GET` the order every 5 seconds while it is `PENDING_PAYMENT`.
   - Show the status, a countdown to `hold_expires_at`, and a **Pay now** button (`/payment`, then go to `checkout_url`) while it's pending.
   - Once `CONFIRMED`, show every code, as in step 2.
   - Without a stored token: "Open this page from the browser you ordered on, or use My Tickets if you were signed in."
3. **Staff:**
   - **New order:** when the total is above zero, require the buyer mobile and a payment option (from the event's payment options).
   - **The order page:** show the payment status and the checkout link (with a *Copy* button). When a staff order is `PENDING_PAYMENT`, show the checkout link and order token once, to give to the buyer.
   - In the Orders tab, show each order's status with a `StatusPill`.
4. **Super Admin, the organization page:** a "Cheche Pay" card showing the service code, its payment options and whether paid sales are available, plus a form with one field, *Cheche Pay service code* (empty turns paid sales off). Show any `warnings[].message` after saving.
5. **Errors in `describeApiError`:**
   - `paid_sales_unavailable`: "Paid tickets aren't available for this event yet."
   - `unknown_payment_option` (an issue code): "That payment option isn't available. Choose another."
   - `payment_provider_unavailable`: "Payment is not available right now. Try again in a moment."
   - `invalid_order_state`: "This order isn't waiting for payment any more."
   - `ticket_not_issued`: "This ticket is waiting for payment."

## When you're done

Report:
- the files you changed;
- the typecheck and lint results;
- screenshots at 375 px and in dark mode of:
  - the paid checkout total and payment options;
  - the order page while pending (countdown, Pay now);
  - the order page once paid;
  - the staff order page with the payment card;
  - the Super Admin Cheche Pay card;
- anything that didn't match the API.
