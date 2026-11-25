import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { Transaction } from "sequelize";
import { fileStorageClient } from "../src/clients/file-storage.client.js";
import {
  FileStorageUnavailableError,
  InvalidEventStateError,
  NotFoundError,
  UnsupportedFileTypeError,
} from "../src/errors/app-errors.js";
import type { EventRow } from "../src/models/event.js";
import { eventRepository } from "../src/repositories/event.repository.js";
import { fileRepository } from "../src/repositories/file.repository.js";
import { eventCoverService } from "../src/services/event-cover.service.js";
import { transactionManager } from "../src/services/helpers.js";
import { eventRow, fileRow, IDS } from "./helpers/fixtures.js";

/** The cover service against mocked repositories, storage and transaction: no database, no disk. */
const FAKE_TX = { id: "fake-transaction" } as unknown as Transaction;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png body")]);
const COVER_KEY = /^events\/covers\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/;

function arrange(options: { event?: EventRow | null; lockedEvent?: EventRow | null } = {}) {
  const event = options.event === undefined ? eventRow() : options.event;
  const lockedEvent = options.lockedEvent === undefined ? event : options.lockedEvent;
  return {
    find: mock.method(eventRepository, "findByOrganizationAndId", async (_organizationId: string, _eventId: string, repoOptions?: { lock?: boolean }) =>
      repoOptions?.lock ? lockedEvent : event,
    ),
    save: mock.method(fileStorageClient, "save", async () => undefined),
    remove: mock.method(fileStorageClient, "delete", async () => undefined),
    createFile: mock.method(fileRepository, "create", async () => fileRow()),
    update: mock.method(
      eventRepository,
      "updateByOrganizationAndId",
      async (_organizationId: string, _eventId: string, values: Partial<EventRow>, _options?: { transaction?: Transaction }) =>
        eventRow({ ...event, ...values }),
    ),
  };
}

beforeEach(() => {
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
});
afterEach(() => mock.restoreAll());

test("an upload that is not a JPEG, PNG or WebP is refused before the event is read or anything is written", async () => {
  const calls = arrange();
  await assert.rejects(
    eventCoverService.setEventCover(IDS.orgA, IDS.event, { bytes: Buffer.from("<svg/>"), originalName: "cover.png" }, IDS.user),
    UnsupportedFileTypeError,
  );
  assert.deepEqual([calls.find.mock.callCount(), calls.save.mock.callCount(), calls.createFile.mock.callCount()], [0, 0, 0]);
});

test("an unknown event, or a CLOSED or CANCELLED one, is refused before anything is written", async () => {
  const missing = arrange({ event: null });
  await assert.rejects(eventCoverService.setEventCover(IDS.orgA, IDS.event, { bytes: PNG, originalName: null }, IDS.user), NotFoundError);
  assert.equal(missing.save.mock.callCount(), 0);
  mock.restoreAll();

  for (const status of ["CLOSED", "CANCELLED"] as const) {
    mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
    const calls = arrange({ event: eventRow({ status }) });
    await assert.rejects(eventCoverService.setEventCover(IDS.orgA, IDS.event, { bytes: PNG, originalName: null }, IDS.user), InvalidEventStateError);
    assert.equal(calls.save.mock.callCount(), 0, status);
    mock.restoreAll();
  }
});

test("a cover is stored under events/covers/<uuid>.<ext>, recorded as EVENT_COVER for the event, and attached in one transaction", async () => {
  const calls = arrange({ event: eventRow({ status: "PUBLISHED" }) });

  const dto = await eventCoverService.setEventCover(IDS.orgA, IDS.event, { bytes: PNG, originalName: "  Summit poster.png  " }, IDS.user);

  const [key, bytes] = calls.save.mock.calls[0]?.arguments ?? [];
  assert.match(String(key), COVER_KEY, "a random name with the detected extension, in the purpose folder");
  assert.deepEqual(bytes, PNG);

  const [values, createOptions] = calls.createFile.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(values, {
    organization_id: IDS.orgA,
    purpose: "EVENT_COVER",
    entity_type: "EVENT",
    entity_id: IDS.event,
    storage_provider: "local",
    storage_key: key,
    content_type: "image/png",
    size_bytes: PNG.length,
    original_name: "Summit poster.png",
    uploaded_by: IDS.user,
    created_by: IDS.user,
    updated_by: IDS.user,
  });
  assert.deepEqual(createOptions, { transaction: FAKE_TX });

  const locked = calls.find.mock.calls.find((call) => call.arguments[2]?.lock === true);
  assert.deepEqual(locked?.arguments[2], { transaction: FAKE_TX, lock: true }, "the event is re-read under a lock");

  const [, , changes, updateOptions] = calls.update.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(changes, { cover_file_id: IDS.file, updated_by: IDS.user });
  assert.deepEqual(updateOptions, { transaction: FAKE_TX });

  assert.deepEqual(dto.cover, { url: `/assets/uploads/${String(key)}` });
  assert.equal(calls.remove.mock.callCount(), 0);
});

test("when recording fails, the file just written is deleted and the error is passed on", async () => {
  const calls = arrange();
  calls.createFile.mock.mockImplementation(async () => {
    throw new Error("insert failed");
  });

  await assert.rejects(eventCoverService.setEventCover(IDS.orgA, IDS.event, { bytes: PNG, originalName: null }, IDS.user), /insert failed/);

  const [savedKey] = calls.save.mock.calls[0]?.arguments ?? [];
  const [removedKey] = calls.remove.mock.calls[0]?.arguments ?? [];
  assert.equal(removedKey, savedKey);
  assert.equal(calls.update.mock.callCount(), 0);
});

test("an event cancelled while the file was being written is refused under the lock, and the file is deleted", async () => {
  const calls = arrange({ event: eventRow({ status: "PUBLISHED" }), lockedEvent: eventRow({ status: "CANCELLED" }) });

  await assert.rejects(eventCoverService.setEventCover(IDS.orgA, IDS.event, { bytes: PNG, originalName: null }, IDS.user), InvalidEventStateError);

  assert.equal(calls.remove.mock.callCount(), 1);
  assert.equal(calls.createFile.mock.callCount(), 0);
});

test("a cleanup failure is logged, and the original error still reaches the caller", async () => {
  const calls = arrange();
  calls.createFile.mock.mockImplementation(async () => {
    throw new Error("insert failed");
  });
  calls.remove.mock.mockImplementation(async () => {
    throw new Error("disk gone");
  });

  await assert.rejects(eventCoverService.setEventCover(IDS.orgA, IDS.event, { bytes: PNG, originalName: null }, IDS.user), /insert failed/);
});

test("a storage failure answers 503 file_storage_unavailable and records nothing", async () => {
  const calls = arrange();
  calls.save.mock.mockImplementation(async () => {
    throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  });

  await assert.rejects(
    eventCoverService.setEventCover(IDS.orgA, IDS.event, { bytes: PNG, originalName: null }, IDS.user),
    (error: unknown) => error instanceof FileStorageUnavailableError && error.statusCode === 503 && error.cause instanceof Error,
  );
  assert.equal(calls.createFile.mock.callCount(), 0);
  assert.equal(calls.remove.mock.callCount(), 0);
});

test("removing a cover detaches it and leaves the file in storage; a CLOSED event's cover cannot change", async () => {
  const calls = arrange({ event: eventRow({ status: "PUBLISHED", cover_file_id: IDS.file }) });

  const dto = await eventCoverService.removeEventCover(IDS.orgA, IDS.event, IDS.user);

  const [, , changes, options] = calls.update.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(changes, { cover_file_id: null, updated_by: IDS.user });
  assert.deepEqual(options, { transaction: FAKE_TX });
  assert.equal(dto.cover, null);
  assert.equal(calls.remove.mock.callCount(), 0, "old files are cleaned up later, not on removal");
  mock.restoreAll();

  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
  const closed = arrange({ event: eventRow({ status: "CLOSED", cover_file_id: IDS.file }) });
  await assert.rejects(eventCoverService.removeEventCover(IDS.orgA, IDS.event, IDS.user), InvalidEventStateError);
  assert.equal(closed.update.mock.callCount(), 0);
});
