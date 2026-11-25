import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
} from "sequelize";
import { sequelize } from "../db.js";
import type { Person } from "./person.js";
import type { TicketType } from "./ticket-type.js";

export const REGISTRATION_STATUSES = ["CONFIRMED", "CANCELLED"] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

export const REGISTRATION_SOURCES = ["STAFF", "PUBLIC"] as const;
export type RegistrationSource = (typeof REGISTRATION_SOURCES)[number];

/**
 * One known guest's place at one event (spec §8). One row per (organization, event, person): cancelling frees the
 * place and registering the same person again reactivates the row (same code). Only CONFIRMED rows consume
 * capacity. `registered_by` is the staff member for STAFF entries and empty for PUBLIC ones.
 */
export class Registration extends Model<InferAttributes<Registration>, InferCreationAttributes<Registration>> {
  declare id: CreationOptional<string>;
  declare organization_id: string;
  declare event_id: string;
  declare person_id: string;
  declare ticket_type_id: string;
  declare status: RegistrationStatus;
  declare source: RegistrationSource;
  declare registered_by: string | null;
  declare registered_at: Date;
  declare cancelled_at: Date | null;
  declare code: string;
  declare privacy_notice_version: string | null;
  declare privacy_notice_shown_at: Date | null;
  declare consent_purpose: string | null;
  declare consent_version: string | null;
  declare consented_at: Date | null;
  declare created_at: CreationOptional<Date>;
  declare updated_at: CreationOptional<Date>;
  declare created_by: string | null;
  declare updated_by: string | null;

  declare person?: NonAttribute<Person>;
  declare ticketType?: NonAttribute<TicketType>;
}

export type RegistrationRow = InferAttributes<Registration>;

Registration.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    organization_id: { type: DataTypes.UUID, allowNull: false },
    event_id: { type: DataTypes.UUID, allowNull: false },
    person_id: { type: DataTypes.UUID, allowNull: false },
    ticket_type_id: { type: DataTypes.UUID, allowNull: false },
    status: { type: DataTypes.STRING(20), allowNull: false },
    source: { type: DataTypes.STRING(20), allowNull: false },
    registered_by: { type: DataTypes.UUID, allowNull: true },
    registered_at: { type: DataTypes.DATE, allowNull: false },
    cancelled_at: { type: DataTypes.DATE, allowNull: true },
    code: { type: DataTypes.STRING(8), allowNull: false },
    privacy_notice_version: { type: DataTypes.STRING(40), allowNull: true },
    privacy_notice_shown_at: { type: DataTypes.DATE, allowNull: true },
    consent_purpose: { type: DataTypes.STRING(80), allowNull: true },
    consent_version: { type: DataTypes.STRING(40), allowNull: true },
    consented_at: { type: DataTypes.DATE, allowNull: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
    created_by: { type: DataTypes.UUID, allowNull: true },
    updated_by: { type: DataTypes.UUID, allowNull: true },
  },
  { sequelize, modelName: "Registration", tableName: "registration" },
);
