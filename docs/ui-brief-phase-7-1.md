# Building brief: ticket prices, staff-only types and registration settings (Phase 7, step 1)

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
8. **Money:** use `formatCurrency` from `lib/format.ts` with the `currency` the API returns. Prices arrive as strings such as `"500.00"`. Never compute with them in floating point.
9. **Check** at 375 px and in dark mode; run the typecheck and lint and report the results.

## API

| Call | What's new |
|---|---|
| `POST` and `PATCH /v1/organizations/{organizationId}/events[/{eventId}]` | **`registration_mode`:** `QUICK` or `DETAILED` (default `DETAILED`). **`holder_fields`:** `{ name, mobile, email, affiliation, country }`, each `REQUIRED`, `OPTIONAL` or `HIDDEN`. All five are sent together. **`purchase_limit_per_mobile`:** a positive whole number, or `null` for no limit. The event reply carries all three. |
| `POST` and `PATCH …/events/{eventId}/ticket-types[/{id}]` | **`price`:** a decimal string such as `"500"` or `"500.50"`, stored as `"500.00"`; `"0"` means free and is the default. **`audience`:** `PUBLIC` (default) or `STAFF_ONLY`. Each ticket type also carries `currency`, which is the organizer's and is never sent. |
| `GET /v1/public/organizations/{orgSlug}/events/{eventSlug}` | `ticket_types` lists only public types, as `{ code, name, price, currency, is_free }`. The page also has `registration_mode`, `holder_fields` and `purchase_limit_per_mobile`. `registration_open` is false when only staff-only types are active. |
| Single-ticket registration (staff and public) | **409 `payment_required`** for a type with a price. **404** on the public form for a staff-only type. **409 `registration_closed`** with `details.reason: "NO_PUBLIC_TICKETS"`. **400** with `issues[].code` `required` or `not_collected` for a `DETAILED` event's fields. |

## Changes

1. **Event form, a new "Registration" card:**
   - **Registration mode:** a two-option choice.
     - "Quick: buyers give one mobile number; tickets can be unnamed".
     - "Detailed: collect each guest's details".
   - **Guest details** (only when Detailed): one row per field (Name, Mobile, Email, Organization or affiliation, Country), each with Required, Optional or Hidden.
   - **Purchase limit:** an optional number. Hint: "The most tickets one mobile number can get for this event, across all orders. Leave empty for no limit."
2. **Ticket types (staff):**
   - Add **Price**, with empty or 0 meaning free, shown with the organizer's currency.
   - Add **Who can get it**: "Anyone with the link" or "Staff only".
   - The list shows the price ("Free" or the formatted amount) and a neutral "Staff only" pill.
3. **Public event page** (not the landing page):
   - Each ticket type shows its price or "Free".
   - Respect `registration_open`.
   - On the current single-guest form, hide paid types for now. Show: "Paid tickets will be available soon."
   - Apply `holder_fields` to the form when the event is Detailed: mark required fields and hide hidden ones.
4. **Staff "Add guest" form:**
   - Staff-only types are listed.
   - Paid types are disabled, with the hint "Paid tickets go through checkout".
5. **Errors in `describeApiError`:**
   - `payment_required`: "This ticket type has a price. It can't be issued here yet."
   - `registration_closed` with `NO_PUBLIC_TICKETS`: "Registration isn't open to the public for this event."

## When you're done

Report:
- the files you changed;
- the typecheck and lint results;
- screenshots at 375 px and in dark mode of:
  - the Registration card;
  - the ticket type form and list;
  - the public event page with a free and a paid type;
- anything that didn't match the API.
