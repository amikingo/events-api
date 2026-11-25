import type { AppModule } from "./module.js";
import type { Branch } from "./branch.js";
import type { CustomerAccount } from "./customer-account.js";
import type { AppEvent } from "./event.js";
import type { MessageOutbox } from "./message-outbox.js";
import type { Organization } from "./organization.js";
import type { Person } from "./person.js";
import type { Registration } from "./registration.js";
import type { Role } from "./role.js";
import type { RoleModuleAccess } from "./role-module-access.js";
import type { StoredFile } from "./stored-file.js";
import type { SubmissionKey } from "./submission-key.js";
import type { TicketType } from "./ticket-type.js";
import type { UserModuleAccess } from "./user-module-access.js";
import type { UserRole } from "./user-role.js";
import type { Venue } from "./venue.js";

type Models = {
  Organization: typeof Organization;
  Branch: typeof Branch;
  AppModule: typeof AppModule;
  Role: typeof Role;
  RoleModuleAccess: typeof RoleModuleAccess;
  UserRole: typeof UserRole;
  UserModuleAccess: typeof UserModuleAccess;
  CustomerAccount: typeof CustomerAccount;
  Venue: typeof Venue;
  StoredFile: typeof StoredFile;
  AppEvent: typeof AppEvent;
  TicketType: typeof TicketType;
  Person: typeof Person;
  Registration: typeof Registration;
  MessageOutbox: typeof MessageOutbox;
  SubmissionKey: typeof SubmissionKey;
};

/** Every association is declared here, once, with an explicit `as` alias and foreign key. */
export function initAssociations(models: Models): void {
  const {
    Organization,
    Branch,
    AppModule,
    Role,
    RoleModuleAccess,
    UserRole,
    UserModuleAccess,
    CustomerAccount,
    Venue,
    StoredFile,
    AppEvent,
    TicketType,
    Person,
    Registration,
    MessageOutbox,
    SubmissionKey,
  } = models;

  Organization.hasMany(Branch, { foreignKey: "organization_id", as: "branches" });
  Branch.belongsTo(Organization, { foreignKey: "organization_id", as: "organization" });

  AppModule.belongsTo(AppModule, { foreignKey: "parent_id", as: "parent" });
  AppModule.hasMany(AppModule, { foreignKey: "parent_id", as: "children" });

  Role.belongsTo(Organization, { foreignKey: "organization_id", as: "organization" });
  Role.hasMany(RoleModuleAccess, { foreignKey: "role_id", as: "accesses" });
  RoleModuleAccess.belongsTo(Role, { foreignKey: "role_id", as: "role" });
  RoleModuleAccess.belongsTo(AppModule, { foreignKey: "module_id", as: "module" });

  UserRole.belongsTo(Role, { foreignKey: "role_id", as: "role" });
  UserRole.belongsTo(Organization, { foreignKey: "organization_id", as: "organization" });
  UserRole.belongsTo(Branch, { foreignKey: "branch_id", as: "branch" });
  UserRole.hasMany(UserModuleAccess, { foreignKey: "user_role_id", as: "overrides" });
  UserModuleAccess.belongsTo(UserRole, { foreignKey: "user_role_id", as: "assignment" });
  UserModuleAccess.belongsTo(AppModule, { foreignKey: "module_id", as: "module" });

  CustomerAccount.belongsTo(Organization, { foreignKey: "organization_id", as: "organization" });
  Venue.belongsTo(Organization, { foreignKey: "organization_id", as: "organization" });
  StoredFile.belongsTo(Organization, { foreignKey: "organization_id", as: "organization" });

  AppEvent.belongsTo(Organization, { foreignKey: "organization_id", as: "organization" });
  AppEvent.belongsTo(Branch, { foreignKey: "branch_id", as: "branch" });
  AppEvent.belongsTo(CustomerAccount, { foreignKey: "customer_account_id", as: "customerAccount" });
  AppEvent.belongsTo(Venue, { foreignKey: "venue_id", as: "venue" });
  AppEvent.belongsTo(StoredFile, { foreignKey: "cover_file_id", as: "coverFile" });
  AppEvent.hasMany(TicketType, { foreignKey: "event_id", as: "ticketTypes" });
  TicketType.belongsTo(AppEvent, { foreignKey: "event_id", as: "event" });

  Person.belongsTo(Organization, { foreignKey: "organization_id", as: "organization" });
  Person.hasMany(Registration, { foreignKey: "person_id", as: "registrations" });
  Registration.belongsTo(AppEvent, { foreignKey: "event_id", as: "event" });
  Registration.belongsTo(Person, { foreignKey: "person_id", as: "person" });
  Registration.belongsTo(TicketType, { foreignKey: "ticket_type_id", as: "ticketType" });
  Registration.hasMany(MessageOutbox, { foreignKey: "registration_id", as: "messages" });
  MessageOutbox.belongsTo(Registration, { foreignKey: "registration_id", as: "registration" });
  SubmissionKey.belongsTo(Registration, { foreignKey: "registration_id", as: "registration" });
}
