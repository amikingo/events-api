# Ticket designs

How an event's tickets look: the organizer chooses a layout, a colour, a few settings and up to three pictures, and
buyers see the same design on their tickets. The booking site draws the tickets; the API only stores the choices. The
ticket's QR still holds the ticket code only.

**Needs migration `20261211000000-create-event-ticket-design`.** Until it has run, every endpoint below that reaches
the new table answers 500. No other endpoint reads it.

## Endpoints

| Method and path | Who | Does |
|---|---|---|
| `GET /v1/organizations/{organizationId}/events/{eventId}/ticket-design` | staff, Events view | the design, or `data: null` |
| `PUT …/ticket-design` | staff, Events update | saves the settings (replaces them) |
| `DELETE …/ticket-design` | staff, Events update | back to the standard designs |
| `PUT …/ticket-design/images/{slot}` | staff, Events update | uploads the `logo`, `picture` or `artwork` |
| `DELETE …/ticket-design/images/{slot}` | staff, Events update | removes that picture |
| `GET /v1/public/organizations/{organizationSlug}/events/{eventSlug}/ticket-design` | anyone, rate limited | the design of a published event, or `data: null` |

## The design

```json
{
  "design": "gold",
  "color": "teal",
  "note": "Bring a photo ID",
  "show_price": true,
  "show_venue": true,
  "show_guest": true,
  "qr": { "x": 0.5, "y": 1, "size": "m" },
  "logo": { "url": "/assets/uploads/events/tickets/<uuid>.png" },
  "picture": null,
  "artwork": null,
  "updated_at": "2026-11-27T12:00:00.000Z"
}
```

- `design`: the booking site's layout name (lowercase letters and hyphens, up to 30). The API doesn't keep a list, so
  a new layout needs no API change. `custom` is the organizer's own artwork.
- `color`: `pink`, `wine`, `purple`, `green`, `amber`, `red`, `orange`, `blue`, `teal`, `black`, or `#rrggbb` in
  lowercase; `null` keeps the design's own colours.
- `note`: up to 60 characters; blank clears it.
- `qr`: where the QR panel goes on custom artwork (`x`, `y` from 0 to 1) and its size (`s`, `m`, `l`).
- In a `PUT`, only `design` is required; anything left out goes back to its default (`color` and `note` null, all
  shown, `qr` `{0.5, 1, m}`). Pictures are not part of it.

## Pictures

JPEG, PNG or WebP up to 5 MB, checked by their contents, sent as `multipart/form-data` with one file in the field
`file`. Stored like covers (`events/tickets/` under `FILES_DIR`, served publicly at `/assets/uploads/…`), one `file`
row per upload with purpose `EVENT_TICKET_LOGO`, `EVENT_TICKET_PICTURE` or `EVENT_TICKET_ARTWORK`. A replaced or
removed picture stays in storage for a later clean-up. Uploading before any settings were saved starts a `poster`
design.

## Rules and errors

- `custom` needs the artwork first: upload it, then save the design (400, issue code `artwork_required`).
- The artwork can't be removed while the design is `custom` (409 `conflict`, `details.reason: "artwork_in_use"`).
- A CLOSED or CANCELLED event keeps its design (409 `invalid_event_state`).
- 404 for an unknown event (publicly: also a draft), or removing a picture when no design is saved; 413 over 5 MB;
  415 not an accepted image; 503 storage unavailable.
- Each change locks the event first, in one transaction.
