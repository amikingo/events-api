# Building brief: changing a guest's ticket type and downloading the guest list (Phase 4d screens)

Copy everything below the line into the agent.

---

You are building screens in **events-web** (Next.js, at `/Users/joedee/cheche-projects/Event_management/events-web`). The API they call, **events-api**, is already built. Build the screens only.

## Rules

1. **Read `events-web/AGENTS.md` first and follow it exactly.** In particular:
   - this Next.js version differs from what you know, so read the guide in `node_modules/next/dist/docs/` before writing code;
   - use the Cheche UI library in `components/ui/`. Pick components with `.cheche-ui/choosing.md`, follow `.cheche-ui/patterns.md`, and look up props in `.cheche-ui/components.md`;
   - tokens only (no hex, no Tailwind palette), Lucide icons, `toast` for results and `Field error=…` for field errors;
   - modals only confirm, or pick (the ticket-type picker below is a pick).
2. **Never edit anything in `components/ui/`.** If a component can't do what you need, stop and ask.
3. **Never touch the landing page:** `app/(home)/`, `components/marketplace/home/`, `components/marketplace/site-footer.tsx` and `components/marketplace/event-card.tsx`. Leave them exactly as they are.
4. **Don't touch:** events-api, any migration or database, and any `.env` file. Never read or print a token or password.
5. **Don't change git** (no commit, push, branch or stash).
6. **Stop and ask** when the API answers differently from this brief. Don't work around it in the screen.
7. **Copy rules:** plain words, sentence case, no "Oops", no exclamation marks. Buttons name the action ("Change ticket type", not "Submit").
8. **Check every screen** at 375 px wide and in dark mode, then run the project's typecheck and lint. Report the results.

## Files to start from

| What | File |
|---|---|
| The event's Guests tab | `app/admin/events/[[...slug]]/registrations-tab.tsx` (rendered from `page.tsx` in the same folder, which passes `canCreate` and `canUpdate`) |
| Registrations API client | `lib/api/registrations.ts` |
| The request helper (bearer token, 401 refresh) | `lib/api-client.ts` |
| Error messages | `lib/api/errors.ts` (`describeApiError`, `grantExceedsOwnAccessMessage`) |
| Role form (grant grid) | `app/admin/access/roles/[[...slug]]/role-form.tsx` |
| Role list and role page (read-only grid) | `app/admin/access/roles/[[...slug]]/page.tsx` |
| Roles API client | `lib/api/roles.ts` |

Every JSON reply uses the existing envelope: `data`, `message`, and on errors `error: { code, message, details }`. The CSV download is the one exception (see 2).

## 1. Change a guest's ticket type

**API:** `PATCH /v1/organizations/{organizationId}/events/{eventId}/registrations/{registrationId}/ticket-type` with `{ ticket_type_id }`.
- The reply is 200 with the registration (same shape as the list rows). `message` is "Ticket type changed", or "Ticket type unchanged" when the guest already had it.
- The guest keeps their code. No SMS is sent.

**Add to `lib/api/registrations.ts`:** `changeRegistrationTicketType(organizationId, eventId, registrationId, ticketTypeId): Promise<Registration>`.

**Screen (Guests tab):**
- A *Change ticket type* row action, next to *Cancel*. Show it only when all of these hold:
  - the person may update guests (`canUpdate`);
  - the event is `PUBLISHED` (also after sign-ups close or during the event);
  - the registration is `CONFIRMED`;
  - the event has more than one active ticket type.
- It opens a picker dialog titled "Change {guest name}'s ticket type":
  - list the event's **active** ticket types from `/registrations/summary` (`ticket_types[]`), each with its places left (`remaining`; `null` means no limit). Mark the guest's current one and don't offer it as a choice;
  - a ticket type with `remaining: 0` is shown but can't be picked ("Full");
  - the button is *Change ticket type*; *Cancel* closes it.
- **On success:** toast "Ticket type changed", then refresh the list and the summary.

**Errors:**

| Status and code | Text (toast) |
|---|---|
| 409 `capacity_reached` (`details.scope: "TICKET_TYPE"`) | "{ticket type} is full. Choose another one." |
| 409 `ticket_type_inactive` | "This ticket type is switched off. Choose another one." |
| 409 `registration_cancelled` | "This guest's registration is cancelled. Bring them back first." |
| 409 `invalid_event_state` | "Ticket types can only be changed while the event is published." |
| 403 `permission_denied` | "You don't have permission to do this." |

After any error, refresh the summary so the places left are current.

## 2. Download the guest list as CSV

**API:** `GET /v1/organizations/{organizationId}/events/{eventId}/registrations/export?status=&ticket_type_id=&q=`.
- It takes the list's filters but **no `page` or `pageSize`** (sending them gives 400). Every matching guest is in one file.
- The success reply is **not JSON**: it's the file itself (`text/csv; charset=utf-8`, with a byte-order mark). Errors are the usual JSON envelope.
- It needs its own right: `/me` `permissions.REGISTRATIONS.export`. Owners have it; Viewers don't.

**Add a download helper to `lib/api-client.ts`,** next to `apiRequest`: `apiDownload(path, { query?, signal? }): Promise<Blob>`.
- It sends the bearer token like `send` does, and on 401 refreshes once and retries, like the existing helpers.
- On success it returns `res.blob()`. On an error status it reads the JSON envelope and throws the same `ApiError` as `send`.
- Don't change how `send` or `apiRequest` behave.

**Add to `lib/api/registrations.ts`:** `downloadGuestList(organizationId, eventId, filters): Promise<Blob>`.

**Screen (Guests tab):**
- A *Download CSV* button in the guest list's toolbar. Show it only with `permissions.REGISTRATIONS.export`: have `page.tsx` pass a `canExport` prop the same way it passes `canCreate` and `canUpdate`.
- It sends the tab's **current** filters (status, ticket type, search).
- Save the blob as `{event.slug}-guests.csv` (an object URL on a temporary link, revoked afterwards).
- While downloading, the button shows its loading state. When done, toast "Guest list downloaded". On an error, `toast.error(describeApiError(...))`.
- Show it for every event status, closed and cancelled included: the list is still worth keeping.

## 3. The Export box on roles

**API:** a role grant now has an optional `export` box, allowed **only on `REGISTRATIONS`** (Guests).
- `GET /roles` already returns `export` on every grant.
- On `POST /roles` and `PATCH /roles/{id}`, send `export` on the Guests row. Left out, it means no on create, and "keep what the role has" on edit.
- `export` on any other module gives 400 `validation_error` at `body.grants.N.export`.
- Granting Export without holding it yourself gives 403 `grant_exceeds_own_access` with `details.action: "export"`.

**Changes:**
- **`lib/api/roles.ts`:** `RoleGrantInput` gains `export?: boolean`.
- **`role-form.tsx`:**
  - the Guests (`REGISTRATIONS`) row gets a fourth box, *Export*. No other row gets it, so give that module `actions: ["view", "create", "update", "export"]` and let the grid show the column only where a row offers it;
  - ticking Export also ticks View, and unticking View clears the whole row, as for Create and Update;
  - `GrantState` and `toGrantPayload` carry `export`. **Always send `export` (true or false) on the Guests row**, and never on any other row;
  - help text under the Guests row: "Export lets them download the guest list with every guest's mobile."
- **Role page (read-only grid):** show Export for the Guests row.
- **`grantExceedsOwnAccessMessage`:** make sure the action reads "Export" for `export`.

## When you're done

Report:
- the files you changed;
- the typecheck and lint results;
- screenshots at 375 px and in dark mode of:
  - the Guests tab with *Download CSV* (as Owner) and without it (as Viewer);
  - the ticket-type picker;
  - the role form with the Export box;
- anything in this brief that didn't match the API.
