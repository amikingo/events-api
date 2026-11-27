# Building brief: scheduled ticket prices (Phase 11)

Copy everything below the line into the agent. It builds on the Phase 7 checkout screens (ticket types with prices, the order page).

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
7. **Dates:** Ethiopian date and time first, then the Gregorian date with a 12-hour time. Never a 24-hour clock. Use the event's own `timezone` for showing and for entering times.
8. **Money:** use `formatCurrency` with the API's `currency`. Amounts are strings. **Never add up prices in the browser to decide what a buyer pays.**
9. **Check** at 375 px and in dark mode; run the typecheck and lint and report the results.

## What the feature is

An organizer can schedule price changes for each ticket type. Take General Admission at a regular price of 500 ETB with a scheduled price of 700 ETB from 18:00 up to 20:00. A buyer who reserves at 17:58 pays 500. One who reserves at 18:01 pays 700. From 20:00 it's 500 again.

The price is fixed when the order is created (when the tickets are reserved), not when the page was opened and not when the buyer pays. Everyone with a GA ticket gets in the same way, whatever they paid.

## API

### Ticket types (staff; *Events › create / update*, as today)

`POST` and `PATCH /v1/organizations/{organizationId}/events/{eventId}/ticket-types[/{ticketTypeId}]` take an extra field:

```jsonc
"price_windows": [
  { "starts_at": "2027-07-01T18:00:00+03:00", "ends_at": "2027-07-01T20:00:00+03:00", "price": "700" },
  { "starts_at": "2027-07-02T09:00:00+03:00", "price": "450" }   // no ends_at: until the schedule changes
]
```

- `starts_at` is included and `ends_at` is excluded. Leaving `ends_at` out means the price lasts until staff change the schedule.
- **Times must carry an offset.** Build them from the date and time the user picks in the event's `timezone`.
- `price` is a decimal string in the ticket type's currency; `"0"` is free.
- There are at most 20 windows.
- Windows can't overlap. Two windows without an end overlap, and so does a window without an end followed by any other window. Adjacent windows, where one ends exactly when the next starts, are fine.
- **On PATCH:** leave `price_windows` out to keep the schedule, send the whole list to replace it, or send `[]` to clear it. Always send the whole list, never one row.
- **Errors:** 400 `validation_error` with `details.issues[]`, where `path` is `body.price_windows.N` and `code` is:
  - `invalid_range`: the end isn't after the start;
  - `overlapping_window`: this row overlaps another.
  Nothing is saved when there's an error, so the old schedule stays.

Every ticket-type reply (create, list, update, status) now carries:

| Field | Meaning |
|---|---|
| `price` | the **regular** price (the editable field, as before) |
| `price_windows` | `[{ id, starts_at, ends_at, price }]`, sorted by start; `ends_at` may be null |
| `effective_price`, `effective_is_free` | what a new order pays **right now** |
| `price_valid_until` | when that changes; null when nothing is scheduled to change |

### Public event page

`GET /v1/public/organizations/{organizationSlug}/events/{eventSlug}` → each `ticket_types[]` item has:
- `price` and `is_free`: what a new order pays **right now**;
- `price_valid_until`: when that changes (null: it doesn't).

### Checkout

There's no new endpoint. The order reply's `total_amount` (and each ticket's price) is what the buyer pays, fixed for that order: retries, payment and refunds all use it.

### Free-only staff paths

These paths only issue free tickets:
- staff *Register a guest* (`POST …/registrations`);
- the public single registration;
- *Move to another ticket type* (`PATCH …/registrations/{id}/ticket-type`).

They answer **409 `payment_required`** when the ticket type costs something **right now**, a scheduled price included. `details` carries `price`, `currency` and `price_valid_until`.

*Bring back* (status → `CONFIRMED`) also answers 409 `payment_required` when that ticket was paid for, even if the type is free now.

## Changes

1. **Staff, the ticket-type form** (create and edit):
   - Keep the *Price* field and label it *Regular price*. Hint: "Used whenever no scheduled price applies."
   - Add a *Scheduled prices* section listing the windows, each with *Starts*, *Ends* (optional), *Price* and a remove button. Add an *Add scheduled price* button.
   - When *Ends* is left empty, show "Until you change it".
   - Sort the rows by start when showing them. On save, send the whole list (or `[]` when every row is removed).
   - Before saving, check in the browser for an end before its start and for overlapping rows, using the same rules as the API. Still show the API's `invalid_range` and `overlapping_window` on the matching row (`body.price_windows.N`).
   - Under the section, show a short preview built from the rows: "Before 18:00: 500 ETB · 18:00–20:00: 700 ETB · From 20:00: 500 ETB", with times in the date rules above.
2. **Staff, the ticket-type list** on the event page:
   - show `effective_price` as the main price;
   - when it differs from `price`, show "Regular {price}" under it;
   - when `price_valid_until` is set, show a small "Changes {time}" line;
   - a type with windows gets a *Scheduled* badge.
3. **Public event page:**
   - show each type's `price` (or *Free*);
   - when `price_valid_until` is set, add "Price changes {time}";
   - if that time passes while the page is open, fetch the event again before the buyer continues.
4. **Checkout and the order page** (public and staff):
   - after the order is created, show **the order's `total_amount`** and each ticket's price, not a total worked out from the event page;
   - if it differs from what the page showed (a scheduled price started in between), show a note above the *Pay* button: "The price changed while you were choosing. This order's total is {total}."
   - Retries and *Pay now* keep that total.
5. **Staff, *Register a guest*, *Move to another ticket type* and *Bring back*:**
   - on 409 `payment_required`, show "This ticket type costs {price} right now. Create an order instead." with a link to the staff order screen for this event;
   - when `price_valid_until` is set, add "The price changes {time}";
   - for *Bring back*: "This ticket was paid for, so it can't come back for free. Sell a new ticket through an order."
6. **Errors in `describeApiError`:**
   - `overlapping_window` (issue code): "This price overlaps another scheduled price."
   - `invalid_range` (issue code): "The end must be after the start."
   - `payment_required`: as in change 5.

## When you're done

Report:
- the files you changed;
- the typecheck and lint results;
- screenshots at 375 px and in dark mode of:
  - the ticket-type form with two scheduled prices and the preview;
  - an overlap error on a row;
  - the staff ticket-type list showing a scheduled price in force;
  - the public event page with "Price changes …";
  - the order page with the "price changed" note;
  - the staff `payment_required` message;
- anything that didn't match the API.
