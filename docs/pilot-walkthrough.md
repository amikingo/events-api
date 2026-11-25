# Pilot walkthrough (Phase 5)

The goal: a guest discovers an event, registers, receives a code, and appears **once** on the staff guest list. Everything runs on your own machine, against `events_dev`.

Tick each step. When something doesn't match, write down the exact message and the `X-Request-Id` (in the browser's Network tab). For a failed API call, also copy its `Request rejected` line from the events-api terminal.

## 0. Setup

**In events-api's `.env`** (you edit it):

| Setting | Set it to |
|---|---|
| `CORS_ALLOWED_ORIGINS` | Includes `http://localhost:3000` |
| `AUTH_REFRESH_TRUSTED_ORIGINS` | Includes `http://localhost:3000`, or is empty in development |
| `FILES_DIR` | An absolute folder that exists, e.g. `/Users/joedee/events-uploads` |
| `SMS_DELIVERY` | `log` (the text appears in the API terminal). For one real SMS, `afromessage` plus the three `PLATFORM_SMS_*` values, and register with **your own** number only. |

**Start both apps:**
- `npm run dev` in `events-api` (port 5010);
- `npm run dev` in `events-web` (port 3000).

**Use two browser windows:** a normal one for staff, and a private one for the visitor.

## 1. As Super Admin: a pilot organization and its Owner

1. Sign in with team sign-in.
2. *Administration › Organizations*: create **Pilot Org**.
   - [ ] It's created.
3. Open Pilot Org, then *Access Control › Roles*.
   - [ ] Owner and Viewer are listed, each with what it may do.
4. *Access Control › Staff Assignments*: add staff with the Owner's mobile (a real Cheche account), then press **Look up**.
   - [ ] Their name appears. This proves the service token against the real auth-cheche.
   - [ ] Choosing **Owner** and adding gives "Staff assignment created".

## 2. As the Owner: an event

1. Sign in as the Owner, in another window or after signing out.
   - [ ] The menu shows Event Management (Events, Clients, Guests) and Access Control (Roles, Staff Assignments).
2. *Events › New*:
   - name **Pilot Forum**;
   - starts tomorrow at 9:00 AM and ends at 5:00 PM;
   - capacity **2**;
   - visibility **Public**.
   - [ ] The time chooser shows hour, minute and AM/PM, never a 24-hour time.
   - [ ] It's created as a draft with General Admission.
3. *Cover* tab: upload a JPEG or PNG under 5 MB.
   - [ ] The picture shows.
4. Press **Publish event**.
   - [ ] Published.
   - [ ] The record shows the dates as e.g. *Hidar 18, 2019 at 3:00 in the morning (Nov 27, 2026, 9:00 AM)*: Ethiopian first, never 24-hour.

## 3. As a visitor (private window, no login)

1. Open `http://localhost:3000`, then *Events*.
   - [ ] Pilot Forum is listed with its cover and the short date (*Hidar 18, 2019 · Nov 27, 9:00 AM*).
   - [ ] No "Few left" badge, and no prices or "Get tickets".
2. Open the event.
   - [ ] The full date and time text.
   - [ ] The privacy notice with its version.
   - [ ] The **Register** form.
3. Register:
   - first and last name;
   - your mobile, **pasted as `+251…`** (it must keep all nine digits);
   - tick the privacy box, then **Register**.
   - [ ] "You're registered", with an 8-character code and the full date.
4. Go back and submit the same details again.
   - [ ] A new submission is a second registration, as designed (each submission is a new guest).

   To see a retry instead: on a slow or offline network, press Register, then press it again once the network is back. You should get "Already registered" with the **same** code. This is optional, and easiest to try with DevTools set to "Offline".

## 4. Back as the Owner: the guest list

1. Pilot Forum, then the *Guests* tab.
   - [ ] The guest appears **once**, "Signed up online", with the same code.
   - [ ] The confirmation changes from *Sending* to *SMS sent* within about 10 seconds (refresh the tab). In `log` mode, the SMS text is in the API terminal.
   - [ ] The summary says *1 of 2 places taken*.
2. Register a second guest as staff (*Register a guest*, new guest).
   - [ ] "Guest registered", with their code.
   - [ ] The summary says *2 of 2*, then *The event is full*.
3. In the visitor window, register a third person.
   - [ ] "This event is full", and nothing is added to the list.
4. Cancel the first guest, then confirm.
   - [ ] Cancelled.
   - [ ] The summary is back to *1 of 2*, with one place left.
5. Press **Bring back** on the same guest.
   - [ ] Confirmed again, with the same code.

## 5. Refusals (optional)

- [ ] Edit Pilot Forum and set *Sign-ups close* to an hour ago. The visitor's event page says registration has closed, and there's no form.
- [ ] Try to lower the capacity below the confirmed guests: "N guests are already confirmed…".

## Done when

Every box in steps 1–4 is ticked. Send me the failures. I'll fix them, and mark Phase 5 done once a full run passes.
