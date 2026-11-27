import { randomUUID } from "node:crypto";
import type { Transaction } from "sequelize";
import { fileStorageClient, STORAGE_PROVIDER } from "../clients/file-storage.client.js";
import { filesConfig } from "../config/files.js";
import { ConflictError, FileStorageUnavailableError, InvalidEventStateError, UnsupportedFileTypeError, ValidationAppError } from "../errors/app-errors.js";
import { toTicketDesignDto, type TicketDesignDto } from "../mappers/ticket-design.mapper.js";
import type { EventTicketDesignRow } from "../models/event-ticket-design.js";
import type { EventRow } from "../models/event.js";
import type { FilePurpose } from "../models/stored-file.js";
import { eventTicketDesignRepository, type EventTicketDesignUpdateValues } from "../repositories/event-ticket-design.repository.js";
import { eventRepository } from "../repositories/event.repository.js";
import { fileRepository } from "../repositories/file.repository.js";
import type { RepoOptions } from "../repositories/helpers.js";
import { detectImageType } from "../utils/image-type.js";
import { logger } from "../utils/logger.js";
import type { TicketDesignSaveInput, TicketImageSlot } from "../validators/ticket-design.js";
import { ensureFound, runTransaction } from "./helpers.js";

/**
 * An event's ticket design: its settings, and up to three pictures stored like covers (local disk under FILES_DIR,
 * in events/tickets/, one `file` row per upload). Every change locks the event first, so two changes to one event's
 * design can't interleave. A closed or cancelled event keeps the design it had.
 */
export type TicketImageUpload = { bytes: Buffer; originalName: string | null };

const SLOTS = {
  logo: { column: "logo_file_id", purpose: "EVENT_TICKET_LOGO" },
  picture: { column: "picture_file_id", purpose: "EVENT_TICKET_PICTURE" },
  artwork: { column: "artwork_file_id", purpose: "EVENT_TICKET_ARTWORK" },
} as const satisfies Record<TicketImageSlot, { column: keyof EventTicketDesignUpdateValues; purpose: FilePurpose }>;

/** The layout a first picture upload starts from, before any settings were saved. */
const FIRST_DESIGN = "poster";

function assertDesignChangeable(event: EventRow): void {
  if (event.status === "CLOSED" || event.status === "CANCELLED") {
    throw new InvalidEventStateError(`A ${event.status} event's ticket design can no longer change`, { status: event.status });
  }
}

async function lockChangeableEvent(organizationId: string, eventId: string, transaction: Transaction): Promise<EventRow> {
  const event = ensureFound(await eventRepository.findByOrganizationAndId(organizationId, eventId, { transaction, lock: true }), "Event not found");
  assertDesignChangeable(event);
  return event;
}

/** The design with its pictures' public paths (one query for all of them). */
async function present(organizationId: string, row: EventTicketDesignRow, options: RepoOptions = {}): Promise<TicketDesignDto> {
  const ids = [row.logo_file_id, row.picture_file_id, row.artwork_file_id].filter((id): id is string => Boolean(id));
  const files = await fileRepository.listByOrganizationAndIds(organizationId, ids, options);
  return toTicketDesignDto(row, new Map(files.map((file) => [file.id, fileStorageClient.url(file.storage_key)])));
}

/** null: no design saved, so the standard designs apply. */
async function getTicketDesign(organizationId: string, eventId: string): Promise<TicketDesignDto | null> {
  ensureFound(await eventRepository.findByOrganizationAndId(organizationId, eventId), "Event not found");
  const row = await eventTicketDesignRepository.findByEvent(organizationId, eventId);
  return row ? present(organizationId, row) : null;
}

/** What buyers see: the design of an event that was published at least once, by both slugs. */
async function getPublicTicketDesign(organizationSlug: string, eventSlug: string): Promise<TicketDesignDto | null> {
  const event = ensureFound(await eventRepository.findPublishedBySlugs(organizationSlug, eventSlug), "Event not found");
  const row = await eventTicketDesignRepository.findByEvent(event.organization_id, event.id);
  return row ? present(event.organization_id, row) : null;
}

async function saveTicketDesign(organizationId: string, eventId: string, input: TicketDesignSaveInput, actorId: string | null): Promise<TicketDesignDto> {
  return runTransaction(async (transaction) => {
    await lockChangeableEvent(organizationId, eventId, transaction);
    const current = await eventTicketDesignRepository.findByEvent(organizationId, eventId, { transaction });
    if (input.design === "custom" && !current?.artwork_file_id) {
      throw new ValidationAppError("Request validation failed", {
        issues: [{ path: "body.design", message: "Upload the artwork before choosing the custom design", code: "artwork_required" }],
      });
    }
    const values = {
      design: input.design,
      color: input.color,
      note: input.note ?? null,
      show_price: input.show_price,
      show_venue: input.show_venue,
      show_guest: input.show_guest,
      qr_x: input.qr.x,
      qr_y: input.qr.y,
      qr_size: input.qr.size,
      updated_by: actorId,
    };
    const saved = current
      ? await eventTicketDesignRepository.updateByEvent(organizationId, eventId, values, { transaction })
      : await eventTicketDesignRepository.create({ ...values, organization_id: organizationId, event_id: eventId, created_by: actorId }, { transaction });
    return present(organizationId, ensureFound(saved, "Ticket design not found"), { transaction });
  });
}

/** Back to the standard designs. Removing a design that isn't there is fine. */
async function removeTicketDesign(organizationId: string, eventId: string, actorId: string | null): Promise<null> {
  return runTransaction(async (transaction) => {
    await lockChangeableEvent(organizationId, eventId, transaction);
    if (await eventTicketDesignRepository.deleteByEvent(organizationId, eventId, { transaction })) {
      logger.info({ organizationId, eventId, actorId }, "Ticket design removed");
    }
    return null;
  });
}

/**
 * Checks the image by its contents, writes it under a random name, then records it and puts it on the design (making
 * the design when there is none) in one transaction. A file written before a failed transaction is deleted.
 */
async function setTicketImage(
  organizationId: string,
  eventId: string,
  slot: TicketImageSlot,
  upload: TicketImageUpload,
  actorId: string | null,
): Promise<TicketDesignDto> {
  const type = detectImageType(upload.bytes);
  if (!type) throw new UnsupportedFileTypeError("Upload a JPEG, PNG or WebP image");
  // Fail fast before touching the disk; the transaction below checks again under a lock.
  assertDesignChangeable(ensureFound(await eventRepository.findByOrganizationAndId(organizationId, eventId), "Event not found"));

  const key = `${filesConfig.ticketFolder}/${randomUUID()}.${type.extension}`;
  try {
    await fileStorageClient.save(key, upload.bytes);
  } catch (error) {
    logger.error({ err: error instanceof Error ? { name: error.name, message: error.message } : error, folder: filesConfig.rootDir }, "Saving a ticket image failed");
    throw new FileStorageUnavailableError("The image could not be stored; try again later", undefined, { cause: error });
  }

  try {
    return await runTransaction(async (transaction) => {
      await lockChangeableEvent(organizationId, eventId, transaction);
      const file = await fileRepository.create(
        {
          organization_id: organizationId,
          purpose: SLOTS[slot].purpose,
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
      const values = { [SLOTS[slot].column]: file.id, updated_by: actorId };
      const current = await eventTicketDesignRepository.findByEvent(organizationId, eventId, { transaction });
      const saved = current
        ? await eventTicketDesignRepository.updateByEvent(organizationId, eventId, values, { transaction })
        : await eventTicketDesignRepository.create(
            { ...values, design: FIRST_DESIGN, color: null, note: null, organization_id: organizationId, event_id: eventId, created_by: actorId },
            { transaction },
          );
      return present(organizationId, ensureFound(saved, "Ticket design not found"), { transaction });
    });
  } catch (error) {
    // Nothing was recorded, so the written file would be an orphan: remove it (best effort).
    await fileStorageClient.delete(key).catch((cleanupError: unknown) => {
      logger.warn({ key, err: cleanupError instanceof Error ? cleanupError.message : cleanupError }, "Removing an unrecorded ticket image failed");
    });
    throw error;
  }
}

/** Takes a picture off the design. The file stays in storage for a later clean-up. */
async function removeTicketImage(organizationId: string, eventId: string, slot: TicketImageSlot, actorId: string | null): Promise<TicketDesignDto> {
  return runTransaction(async (transaction) => {
    await lockChangeableEvent(organizationId, eventId, transaction);
    const current = ensureFound(await eventTicketDesignRepository.findByEvent(organizationId, eventId, { transaction }), "Ticket design not found");
    if (slot === "artwork" && current.design === "custom") {
      throw new ConflictError("Choose another design before removing the artwork", { reason: "artwork_in_use" });
    }
    const updated = await eventTicketDesignRepository.updateByEvent(
      organizationId,
      eventId,
      { [SLOTS[slot].column]: null, updated_by: actorId },
      { transaction },
    );
    return present(organizationId, ensureFound(updated, "Ticket design not found"), { transaction });
  });
}

export const ticketDesignService = {
  getTicketDesign,
  getPublicTicketDesign,
  saveTicketDesign,
  removeTicketDesign,
  setTicketImage,
  removeTicketImage,
};
