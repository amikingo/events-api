import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { Transaction } from "sequelize";
import { fileStorageClient } from "../src/clients/file-storage.client.js";
import { ConflictError, FileStorageUnavailableError, InvalidEventStateError, NotFoundError, UnsupportedFileTypeError, ValidationAppError } from "../src/errors/app-errors.js";
import type { EventTicketDesignRow } from "../src/models/event-ticket-design.js";
import type { EventRow } from "../src/models/event.js";
import { eventTicketDesignRepository } from "../src/repositories/event-ticket-design.repository.js";
import { eventRepository, type PublicEventRow } from "../src/repositories/event.repository.js";
import { fileRepository } from "../src/repositories/file.repository.js";
import { transactionManager } from "../src/services/helpers.js";
import { ticketDesignService } from "../src/services/ticket-design.service.js";
import { ticketDesignSaveSchema } from "../src/validators/ticket-design.js";
import { eventRow, fileRow, IDS, ticketDesignRow } from "./helpers/fixtures.js";

/** The ticket design service against mocked repositories, storage and transaction: no database, no disk. */
const FAKE_TX = { id: "fake-transaction" } as unknown as Transaction;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png body")]);
const IMAGE_KEY = /^events\/tickets\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/;

function arrange(options: { event?: EventRow | null; design?: EventTicketDesignRow | null } = {}) {
  const event = options.event === undefined ? eventRow({ status: "PUBLISHED" }) : options.event;
  const design = options.design === undefined ? null : options.design;
  return {
    findEvent: mock.method(eventRepository, "findByOrganizationAndId", async () => event),
    findDesign: mock.method(eventTicketDesignRepository, "findByEvent", async () => design),
    createDesign: mock.method(eventTicketDesignRepository, "create", async (values: Partial<EventTicketDesignRow>) => ticketDesignRow(values)),
    updateDesign: mock.method(
      eventTicketDesignRepository,
      "updateByEvent",
      async (_organizationId: string, _eventId: string, values: Partial<EventTicketDesignRow>) => ticketDesignRow({ ...design, ...values }),
    ),
    deleteDesign: mock.method(eventTicketDesignRepository, "deleteByEvent", async () => design !== null),
    listFiles: mock.method(fileRepository, "listByOrganizationAndIds", async (_organizationId: string, ids: readonly string[]) =>
      ids.map((id) => fileRow({ id, storage_key: `events/tickets/${id}.png` })),
    ),
    createFile: mock.method(fileRepository, "create", async () => fileRow({ purpose: "EVENT_TICKET_LOGO" })),
    save: mock.method(fileStorageClient, "save", async () => undefined),
    remove: mock.method(fileStorageClient, "delete", async () => undefined),
  };
}

const input = (body: Record<string, unknown>) => ticketDesignSaveSchema.parse(body);

beforeEach(() => {
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
});
afterEach(() => mock.restoreAll());

test("no saved design reads as null; a saved one has its pictures' public paths", async () => {
  arrange();
  assert.equal(await ticketDesignService.getTicketDesign(IDS.orgA, IDS.event), null);
  mock.restoreAll();

  const calls = arrange({ design: ticketDesignRow({ logo_file_id: IDS.file, color: "blue", qr_x: 0.25 }) });
  const dto = await ticketDesignService.getTicketDesign(IDS.orgA, IDS.event);
  assert.deepEqual([dto?.design, dto?.color, dto?.qr, dto?.logo, dto?.picture], [
    "gold",
    "blue",
    { x: 0.25, y: 1, size: "m" },
    { url: `/assets/uploads/events/tickets/${IDS.file}.png` },
    null,
  ]);
  assert.deepEqual(calls.listFiles.mock.calls[0]?.arguments.slice(0, 2), [IDS.orgA, [IDS.file]]);
});

test("the settings default to the design's own colours, everything shown and the QR at the bottom", () => {
  assert.deepEqual(input({ design: "poster" }), {
    design: "poster",
    color: null,
    show_price: true,
    show_venue: true,
    show_guest: true,
    qr: { x: 0.5, y: 1, size: "m" },
  });
  for (const body of [
    { design: "Poster" },
    { design: "poster", color: "chartreuse" },
    { design: "poster", color: "#ABCDEF" },
    { design: "poster", note: "x".repeat(61) },
    { design: "poster", qr: { x: 2, y: 0, size: "m" } },
    { design: "poster", logo_file_id: IDS.file },
  ]) {
    assert.equal(ticketDesignSaveSchema.safeParse(body).success, false, JSON.stringify(body));
  }
  assert.equal(ticketDesignSaveSchema.safeParse({ design: "gold", color: "#0a1b2c", note: "  " }).data?.note, null);
});

test("saving creates the design the first time and replaces it after, under the event's lock", async () => {
  const first = arrange();
  await ticketDesignService.saveTicketDesign(IDS.orgA, IDS.event, input({ design: "gold", color: "teal", note: "Bring a photo ID" }), IDS.user);
  const [values, createOptions] = first.createDesign.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(
    [values?.organization_id, values?.event_id, values?.design, values?.color, values?.note, values?.created_by],
    [IDS.orgA, IDS.event, "gold", "teal", "Bring a photo ID", IDS.user],
  );
  assert.equal((createOptions as { transaction: Transaction }).transaction, FAKE_TX);
  assert.deepEqual(first.findEvent.mock.calls[0]?.arguments[2], { transaction: FAKE_TX, lock: true });
  mock.restoreAll();

  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
  const again = arrange({ design: ticketDesignRow({ note: "Old", color: "red", logo_file_id: IDS.file }) });
  const dto = await ticketDesignService.saveTicketDesign(IDS.orgA, IDS.event, input({ design: "pop" }), IDS.user);
  assert.equal(again.createDesign.mock.callCount(), 0);
  assert.deepEqual([dto.design, dto.color, dto.note, dto.logo !== null], ["pop", null, null, true], "settings are replaced; pictures are kept");
});

test("custom needs artwork, and artwork in use can't be removed", async () => {
  const bare = arrange();
  await assert.rejects(ticketDesignService.saveTicketDesign(IDS.orgA, IDS.event, input({ design: "custom" }), IDS.user), ValidationAppError);
  assert.equal(bare.createDesign.mock.callCount(), 0);
  mock.restoreAll();

  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
  const custom = arrange({ design: ticketDesignRow({ design: "custom", artwork_file_id: IDS.file }) });
  await ticketDesignService.saveTicketDesign(IDS.orgA, IDS.event, input({ design: "custom", qr: { x: 1, y: 0.5, size: "l" } }), IDS.user);
  await assert.rejects(ticketDesignService.removeTicketImage(IDS.orgA, IDS.event, "artwork", IDS.user), ConflictError);
  assert.equal(custom.updateDesign.mock.callCount(), 1, "only the save changed it");
});

test("an unknown event is 404, and a CLOSED or CANCELLED one keeps its design", async () => {
  arrange({ event: null });
  await assert.rejects(ticketDesignService.saveTicketDesign(IDS.orgA, IDS.event, input({ design: "gold" }), IDS.user), NotFoundError);
  mock.restoreAll();

  for (const status of ["CLOSED", "CANCELLED"] as const) {
    mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
    const calls = arrange({ event: eventRow({ status }), design: ticketDesignRow() });
    await assert.rejects(ticketDesignService.saveTicketDesign(IDS.orgA, IDS.event, input({ design: "gold" }), IDS.user), InvalidEventStateError);
    await assert.rejects(ticketDesignService.removeTicketDesign(IDS.orgA, IDS.event, IDS.user), InvalidEventStateError);
    await assert.rejects(ticketDesignService.setTicketImage(IDS.orgA, IDS.event, "logo", { bytes: PNG, originalName: null }, IDS.user), InvalidEventStateError);
    assert.deepEqual([calls.deleteDesign.mock.callCount(), calls.save.mock.callCount()], [0, 0], status);
    mock.restoreAll();
  }
});

test("a picture is checked by its contents, stored under events/tickets/, recorded and put on its slot", async () => {
  const refused = arrange();
  await assert.rejects(
    ticketDesignService.setTicketImage(IDS.orgA, IDS.event, "logo", { bytes: Buffer.from("<svg/>"), originalName: "logo.png" }, IDS.user),
    UnsupportedFileTypeError,
  );
  assert.equal(refused.save.mock.callCount(), 0);
  mock.restoreAll();

  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
  const calls = arrange();
  const dto = await ticketDesignService.setTicketImage(IDS.orgA, IDS.event, "logo", { bytes: PNG, originalName: " Logo.png " }, IDS.user);
  const key = calls.save.mock.calls[0]?.arguments[0];
  assert.match(String(key), IMAGE_KEY);
  const [file] = calls.createFile.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(
    [file?.organization_id, file?.purpose, file?.entity_type, file?.entity_id, file?.storage_key, file?.original_name],
    [IDS.orgA, "EVENT_TICKET_LOGO", "EVENT", IDS.event, key, "Logo.png"],
  );
  const [made] = calls.createDesign.mock.calls[0]?.arguments ?? [];
  assert.deepEqual([made?.design, made?.logo_file_id], ["poster", IDS.file], "a first upload starts a poster design");
  assert.ok(dto.logo);
});

test("a storage failure is 503; a failed transaction removes the written file", async () => {
  arrange();
  mock.method(fileStorageClient, "save", async () => {
    throw new Error("disk full");
  });
  await assert.rejects(
    ticketDesignService.setTicketImage(IDS.orgA, IDS.event, "picture", { bytes: PNG, originalName: null }, IDS.user),
    FileStorageUnavailableError,
  );
  mock.restoreAll();

  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
  const calls = arrange();
  mock.method(fileRepository, "create", async () => {
    throw new Error("database refused");
  });
  await assert.rejects(ticketDesignService.setTicketImage(IDS.orgA, IDS.event, "picture", { bytes: PNG, originalName: null }, IDS.user), /database refused/);
  assert.equal(calls.remove.mock.calls[0]?.arguments[0], calls.save.mock.calls[0]?.arguments[0]);
});

test("buyers read the design of a published event by its slugs; a draft is 404", async () => {
  arrange({ design: ticketDesignRow({ design: "gala" }) });
  const published = mock.method(eventRepository, "findPublishedBySlugs", async () => eventRow({ status: "PUBLISHED" }) as PublicEventRow);
  assert.equal((await ticketDesignService.getPublicTicketDesign("selam", "banking-forum"))?.design, "gala");
  assert.deepEqual(published.mock.calls[0]?.arguments.slice(0, 2), ["selam", "banking-forum"]);
  mock.method(eventRepository, "findPublishedBySlugs", async () => null);
  await assert.rejects(ticketDesignService.getPublicTicketDesign("selam", "draft"), NotFoundError);
});
