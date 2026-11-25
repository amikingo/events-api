import { randomUUID } from "node:crypto";
import type { Transaction } from "sequelize";
import { fileStorageClient, STORAGE_PROVIDER } from "../clients/file-storage.client.js";
import { filesConfig } from "../config/files.js";
import { FileStorageUnavailableError, InvalidEventStateError, UnsupportedFileTypeError } from "../errors/app-errors.js";
import { toEventDto, type EventDto } from "../mappers/event.mapper.js";
import type { EventRow } from "../models/event.js";
import { eventRepository } from "../repositories/event.repository.js";
import { fileRepository } from "../repositories/file.repository.js";
import { detectImageType } from "../utils/image-type.js";
import { logger } from "../utils/logger.js";
import { ensureFound, runTransaction } from "./helpers.js";

/**
 * Event covers (Phase 3d), stored the way bookings_api does: local disk under FILES_DIR, in events/covers/, one
 * `file` row per upload. A replaced or removed cover stays in storage for a later clean-up.
 */
export type CoverUpload = { bytes: Buffer; originalName: string | null };

function assertCoverChangeable(event: EventRow): void {
  if (event.status === "CLOSED" || event.status === "CANCELLED") {
    throw new InvalidEventStateError(`A ${event.status} event's cover can no longer change`, { status: event.status });
  }
}

async function lockChangeableEvent(organizationId: string, eventId: string, transaction: Transaction): Promise<EventRow> {
  const event = ensureFound(await eventRepository.findByOrganizationAndId(organizationId, eventId, { transaction, lock: true }), "Event not found");
  assertCoverChangeable(event);
  return event;
}

/**
 * Checks the image by its contents, writes it under a random name, then records it and attaches it to the event in
 * one transaction. Nothing is written for a refused upload; a file written before a failed transaction is deleted.
 */
async function setEventCover(organizationId: string, eventId: string, upload: CoverUpload, actorId: string | null): Promise<EventDto> {
  const type = detectImageType(upload.bytes);
  if (!type) throw new UnsupportedFileTypeError("Upload a JPEG, PNG or WebP image");
  // Fail fast before touching the disk; the transaction below checks again under a lock.
  assertCoverChangeable(ensureFound(await eventRepository.findByOrganizationAndId(organizationId, eventId), "Event not found"));

  const key = `${filesConfig.coverFolder}/${randomUUID()}.${type.extension}`;
  try {
    await fileStorageClient.save(key, upload.bytes);
  } catch (error) {
    logger.error({ err: error instanceof Error ? { name: error.name, message: error.message } : error, folder: filesConfig.rootDir }, "Saving a cover failed");
    throw new FileStorageUnavailableError("The cover could not be stored; try again later", undefined, { cause: error });
  }

  try {
    return await runTransaction(async (transaction) => {
      await lockChangeableEvent(organizationId, eventId, transaction);
      const file = await fileRepository.create(
        {
          organization_id: organizationId,
          purpose: "EVENT_COVER",
          entity_type: "EVENT",
          entity_id: eventId,
          storage_provider: STORAGE_PROVIDER,
          storage_key: key,
          content_type: type.contentType,
          size_bytes: upload.bytes.length,
          original_name: upload.originalName?.trim().slice(0, 255) || null,
          uploaded_by: actorId,
          created_by: actorId,
          updated_by: actorId,
        },
        { transaction },
      );
      const updated = await eventRepository.updateByOrganizationAndId(
        organizationId,
        eventId,
        { cover_file_id: file.id, updated_by: actorId },
        { transaction },
      );
      return toEventDto(ensureFound(updated, "Event not found"), new Date(), { url: fileStorageClient.url(key) });
    });
  } catch (error) {
    // Nothing was recorded, so the written file would be an orphan: remove it (best effort).
    await fileStorageClient.delete(key).catch((cleanupError: unknown) => {
      logger.warn({ key, err: cleanupError instanceof Error ? cleanupError.message : cleanupError }, "Removing an unrecorded cover failed");
    });
    throw error;
  }
}

/** Detaches the cover. The file stays in storage for a later clean-up. */
async function removeEventCover(organizationId: string, eventId: string, actorId: string | null): Promise<EventDto> {
  return runTransaction(async (transaction) => {
    await lockChangeableEvent(organizationId, eventId, transaction);
    const updated = await eventRepository.updateByOrganizationAndId(
      organizationId,
      eventId,
      { cover_file_id: null, updated_by: actorId },
      { transaction },
    );
    return toEventDto(ensureFound(updated, "Event not found"));
  });
}

export const eventCoverService = { setEventCover, removeEventCover };
