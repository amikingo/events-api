import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../db.js";

export type MessageKind = "REGISTRATION_CONFIRMATION" | "ORDER_CONFIRMATION" | "EVENT_CANCELLED" | "EVENT_RESCHEDULED";
export type MessageChannel = "SMS";
export const MESSAGE_STATUSES = ["PENDING", "SENT", "FAILED", "SKIPPED"] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/** What a registration confirmation needs; the text is rendered when it is sent (Phase 4c). */
export type RegistrationConfirmationPayload = {
  first_name: string;
  organization_name: string;
  event_name: string;
  starts_at: string | null;
  timezone: string;
  code: string;
};

/**
 * What an order confirmation needs (Phase 7): one SMS to the buyer with the order's codes. An order with more codes
 * than fit is sent as several messages (`part` of `parts`).
 */
export type OrderConfirmationPayload = {
  organization_name: string;
  event_name: string;
  starts_at: string | null;
  timezone: string;
  ticket_count: number;
  codes: string[];
  part: number;
  parts: number;
};

/**
 * Phase 9: the event was cancelled. One SMS per affected order: `refund_amount` (a two-place string, "0.00" for none)
 * is what is due on its unused paid tickets, plus used ones only when the organizer approved that.
 */
export type EventCancelledPayload = {
  organization_name: string;
  event_name: string;
  starts_at: string | null;
  timezone: string;
  refund_amount: string;
  currency: string;
};

/** Phase 9: the event moved. One SMS per order with issued tickets; `doors_open_at` only when it differs from the start. */
export type EventRescheduledPayload = {
  organization_name: string;
  event_name: string;
  starts_at: string;
  doors_open_at: string | null;
  timezone: string;
};

export type MessagePayload = RegistrationConfirmationPayload | OrderConfirmationPayload | EventCancelledPayload | EventRescheduledPayload;

/**
 * A message queued in the same transaction as the change it reports (spec rule 5) and delivered after commit by the
 * outbox worker, which may retry it without touching the registration. Not one of the eight business tables.
 */
export class MessageOutbox extends Model<InferAttributes<MessageOutbox>, InferCreationAttributes<MessageOutbox>> {
  declare id: CreationOptional<string>;
  declare organization_id: string;
  /** The registration it reports, or (Phase 7) the order: exactly one is set. */
  declare registration_id: string | null;
  declare order_id: string | null;
  declare kind: MessageKind;
  declare channel: MessageChannel;
  declare recipient: string;
  declare payload: MessagePayload;
  declare status: CreationOptional<MessageStatus>;
  declare attempts: CreationOptional<number>;
  declare next_attempt_at: CreationOptional<Date>;
  declare last_error: CreationOptional<string | null>;
  declare sent_at: CreationOptional<Date | null>;
  declare provider_message_id: CreationOptional<string | null>;
  declare created_at: CreationOptional<Date>;
  declare updated_at: CreationOptional<Date>;
}

export type MessageOutboxRow = InferAttributes<MessageOutbox>;

MessageOutbox.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    organization_id: { type: DataTypes.UUID, allowNull: false },
    registration_id: { type: DataTypes.UUID, allowNull: true },
    order_id: { type: DataTypes.UUID, allowNull: true },
    kind: { type: DataTypes.STRING(40), allowNull: false },
    channel: { type: DataTypes.STRING(20), allowNull: false },
    recipient: { type: DataTypes.STRING(32), allowNull: false },
    payload: { type: DataTypes.JSONB, allowNull: false },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "PENDING" },
    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    next_attempt_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    last_error: { type: DataTypes.STRING(500), allowNull: true },
    sent_at: { type: DataTypes.DATE, allowNull: true },
    provider_message_id: { type: DataTypes.STRING(120), allowNull: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  { sequelize, modelName: "MessageOutbox", tableName: "message_outbox" },
);
