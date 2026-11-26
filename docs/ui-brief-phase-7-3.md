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

Payments go through **Cheche Pay**. Each organizer has its own Cheche Pay account, set up by the Super Admin. The buyer doesn't choose a payment method on our site: Cheche Pay's own checkout page offers the ways to pay.

| Call | What it does |
|---|---|
| `POST /v1/public/organizations/{orgSlug}/events/{eventSlug}/orders` | Same checkout as step 2. A paid order answers **201** with `status: "PENDING_PAYMENT"`, `hold_expires_at`, `payment: { status, checkout_url, checkout_expires_at }`, tickets with `code: null` and `status: "HELD"`, and `order_token`. **409 `paid_sales_unavailable`**: the organizer can't sell paid tickets yet. |
| `GET /v1/public/orders/{reference}` | **The order page.** Header `X-Order-Token: {order_token}`. Status, payment link, and every ticket code once paid. A wrong token is 404. |
| `POST /v1/public/orders/{reference}/check` | Header `X-Order-Token`. **The buyer is back from Cheche Pay:** the server asks Cheche Pay now and returns the order, with the codes once paid. **502 `payment_provider_unavailable`**: keep polling with `GET`. |
| `POST /v1/public/orders/{reference}/payment` | Header `X-Order-Token`. **Pay now:** returns the order with `payment.checkout_url` (the same link while it's still valid, otherwise a new one). **502 `payment_provider_unavailable`**: try again. **409 `invalid_order_state`**: the order isn't waiting for payment. |
| `POST /v1/organizations/{organizationId}/events/{eventId}/orders` | Staff checkout, as in step 2. A paid order also needs `buyer_mobile`, and answers with `payment.checkout_url` and `order_token` once. |
| `GET`, `PUT`, `DELETE /v1/organizations/{organizationId}/cheche-pay`, `POST …/cheche-pay/check` | **Super Admin only:** the organizer's Cheche Pay keys. Read the reply fields below. |

**The Cheche Pay keys** (Super Admin):
- `PUT { secret_key?, webhook_secret?, is_active? }`:
  - `secret_key` (starts with `sk_test_` or `sk_live_`) is required the first time; sent again, it replaces the key;
  - `webhook_secret: null` clears it;
  - `is_active: false` stops new payments.
  - A `pk_` key is **400** with `details.issues[0].code` `publishable_key`. Show that issue's `message`.
- **The reply never contains a secret:** `{ configured, is_active, key_mode ("test" or "live"), secret_key_masked (e.g. "sk_test_••••ab12"), has_webhook_secret, webhook_url, paid_sales_available, updated_at }`.
- `POST …/check` answers `{ ok, reason, key_mode, checked_at }`, where `reason` is `KEY_ACCEPTED`, `KEY_REJECTED` or `PROVIDER_ERROR`.
- `DELETE` removes the keys for good. Payments already started can then no longer be confirmed, so offer *Switch off* (`is_active: false`) first.

**Order statuses:**
- `PENDING_PAYMENT`: "Waiting for payment"; the places are held until `hold_expires_at`.
- `CONFIRMED`: "Paid".
- `EXPIRED`: "Not paid in time".
- `REFUND_REQUIRED`: "Paid after the places were released. The organizer will refund you."

## Changes

1. **Public checkout:**
   - Paid ticket types can now be chosen, and the form shows the total.
   - After a `PENDING_PAYMENT` reply:
     - keep `{ reference, order_token }` in the browser's local storage, keyed by reference;
     - send the buyer to `payment.checkout_url`. Cheche Pay brings them back to `/orders/{reference}`.
   - If `checkout_url` is null, show "Preparing your payment…" and call `/payment` again, at most 3 times.
2. **Order page** (`/orders/{reference}`, where Cheche Pay sends the buyer back):
   - Read the token from storage. On arrival, call `/check` once, then `GET` the order every 5 seconds while it is `PENDING_PAYMENT`.
   - Show the status, a countdown to `hold_expires_at`, and a **Pay now** button (`/payment`, then go to `checkout_url`) while it's pending.
   - Once `CONFIRMED`, show every code, as in step 2.
   - Without a stored token: "Open this page from the browser you ordered on, or use My Tickets if you were signed in."
3. **Staff:**
   - **New order:** when the total is above zero, require the buyer mobile.
   - **The order page:** show the payment status and the checkout link (with a *Copy* button). When a staff order is `PENDING_PAYMENT`, show the checkout link and order token once, to give to the buyer.
   - In the Orders tab, show each order's status with a `StatusPill`.
4. **Super Admin, the organization page:** a "Cheche Pay" card.
   - **It shows:**
     - whether keys are saved;
     - the masked key and its mode (a "Test" or "Live" `StatusPill`);
     - whether a webhook secret is saved;
     - whether paid sales are available;
     - the `webhook_url` with a *Copy* button and the hint "Give this address to Cheche Pay".
   - **A form:**
     - *Secret key*: a password-type field, left empty to keep the saved key;
     - *Webhook secret*: a password-type field, with a *Remove* action that sends `null`;
     - *Paid sales on*: a switch for `is_active`.
   - **Actions:** *Check connection* shows the `reason` as a toast. *Remove keys* uses a confirm dialog.
   - **Never show or log a key after it's sent.**
5. **Errors in `describeApiError`:**
   - `paid_sales_unavailable`: "Paid tickets aren't available for this event yet."
   - `payment_provider_unavailable`: "Payment is not available right now. Try again in a moment."
   - `invalid_order_state`: "This order isn't waiting for payment any more."
   - `ticket_not_issued`: "This ticket is waiting for payment."

## When you're done

Report:
- the files you changed;
- the typecheck and lint results;
- screenshots at 375 px and in dark mode of:
  - the paid checkout total;
  - the order page while pending (countdown, Pay now);
  - the order page once paid;
  - the staff order page with the payment card;
  - the Super Admin Cheche Pay card;
- anything that didn't match the API.
