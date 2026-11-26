import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../db.js";
import { DEFAULT_HOLDER_FIELDS } from "../utils/holder-fields.js";

export const EVENT_STATUSES = ["DRAFT", "PUBLISHED", "CLOSED", "CANCELLED"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];
export const EVENT_VISIBILITIES = ["PUBLIC", "UNLISTED"] as const;
export type EventVisibility = (typeof EVENT_VISIBILITIES)[number];

/** Phase 7: QUICK collects one buyer mobile (tickets may be unnamed); DETAILED collects each ticket holder's details. */
export const REGISTRATION_MODES = ["QUICK", "DETAILED"] as const;
export type RegistrationMode = (typeof REGISTRATION_MODES)[number];

/** The holder details a DETAILED event may collect, and how each one is asked for. */
export const HOLDER_FIELD_KEYS = ["name", "mobile", "email", "affiliation", "country"] as const;
export type HolderFieldKey = (typeof HOLDER_FIELD_KEYS)[number];
export const HOLDER_FIELD_SETTINGS = ["REQUIRED", "OPTIONAL", "HIDDEN"] as const;
export type HolderFieldSetting = (typeof HOLDER_FIELD_SETTINGS)[number];
export type HolderFields = Record<HolderFieldKey, HolderFieldSetting>;

/**
 * One event hosted by the organizer (spec §5; table `event`). Named `AppEvent` because a bare `Event` would shadow
 * the runtime's global Event class. `branch_id = NULL` means organization-wide, even when a default branch exists.
 * `timezone` is copied from the organization when the event is created and never follows later changes there.
 */
export class AppEvent extends Model<InferAttributes<AppEvent>, InferCreationAttributes<AppEvent>> {
  declare id: CreationOptional<string>;
  declare organization_id: string;
  declare branch_id: string | null;
  declare customer_account_id: string | null;
  declare venue_id: string | null;
  declare cover_file_id: string | null;
  declare name: string;
  declare slug: string;
  declare description: string | null;
  declare starts_at: Date | null;
  declare ends_at: Date | null;
  declare timezone: string;
  declare status: CreationOptional<EventStatus>;
  declare capacity: number | null;
  declare registration_opens_at: Date | null;
  declare registration_closes_at: Date | null;
  declare visibility: CreationOptional<EventVisibility>;
  declare category: string | null;
  declare registration_mode: CreationOptional<RegistrationMode>;
  declare holder_fields: CreationOptional<HolderFields>;
  /** Most tickets one buyer mobile may hold at this event, across every order; null means no limit. */
  declare purchase_limit_per_mobile: number | null;
  /** Server-managed: set once when first published, kept after closing or cancelling. Public links need it. */
  declare published_at: CreationOptional<Date | null>;
  declare created_at: CreationOptional<Date>;
  declare updated_at: CreationOptional<Date>;
  declare created_by: string | null;
  declare updated_by: string | null;
}

export type EventRow = InferAttributes<AppEvent>;

AppEvent.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    organization_id: { type: DataTypes.UUID, allowNull: false },
    branch_id: { type: DataTypes.UUID, allowNull: true },
    customer_account_id: { type: DataTypes.UUID, allowNull: true },
    venue_id: { type: DataTypes.UUID, allowNull: true },
    cover_file_id: { type: DataTypes.UUID, allowNull: true },
    name: { type: DataTypes.STRING(255), allowNull: false },
    slug: { type: DataTypes.STRING(120), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    starts_at: { type: DataTypes.DATE, allowNull: true },
    ends_at: { type: DataTypes.DATE, allowNull: true },
    timezone: { type: DataTypes.STRING(64), allowNull: false },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "DRAFT" },
    capacity: { type: DataTypes.INTEGER, allowNull: true },
    registration_opens_at: { type: DataTypes.DATE, allowNull: true },
    registration_closes_at: { type: DataTypes.DATE, allowNull: true },
    visibility: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "UNLISTED" },
    category: { type: DataTypes.STRING(80), allowNull: true },
    registration_mode: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "DETAILED" },
    holder_fields: { type: DataTypes.JSONB, allowNull: false, defaultValue: DEFAULT_HOLDER_FIELDS },
    purchase_limit_per_mobile: { type: DataTypes.INTEGER, allowNull: true },
    published_at: { type: DataTypes.DATE, allowNull: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
    created_by: { type: DataTypes.UUID, allowNull: true },
    updated_by: { type: DataTypes.UUID, allowNull: true },
  },
  { sequelize, modelName: "AppEvent", tableName: "event" },
);
