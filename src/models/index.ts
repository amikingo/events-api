import { AppModule } from "./module.js";
import { Branch } from "./branch.js";
import { CustomerAccount } from "./customer-account.js";
import { AppEvent } from "./event.js";
import { initAssociations } from "./init-associations.js";
import { MessageOutbox } from "./message-outbox.js";
import { Organization } from "./organization.js";
import { Person } from "./person.js";
import { Registration } from "./registration.js";
import { Role } from "./role.js";
import { RoleModuleAccess } from "./role-module-access.js";
import { StoredFile } from "./stored-file.js";
import { SubmissionKey } from "./submission-key.js";
import { TicketType } from "./ticket-type.js";
import { UserModuleAccess } from "./user-module-access.js";
import { UserRole } from "./user-role.js";
import { Venue } from "./venue.js";

initAssociations({
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
});

export {
  AppEvent,
  AppModule,
  Branch,
  CustomerAccount,
  MessageOutbox,
  Organization,
  Person,
  Registration,
  Role,
  RoleModuleAccess,
  StoredFile,
  SubmissionKey,
  TicketType,
  UserModuleAccess,
  UserRole,
  Venue,
};
