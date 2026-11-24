import { AppModule } from "./module.js";
import { Branch } from "./branch.js";
import { CustomerAccount } from "./customer-account.js";
import { initAssociations } from "./init-associations.js";
import { Organization } from "./organization.js";
import { Role } from "./role.js";
import { RoleModuleAccess } from "./role-module-access.js";
import { UserModuleAccess } from "./user-module-access.js";
import { UserRole } from "./user-role.js";
import { Venue } from "./venue.js";

initAssociations({ Organization, Branch, AppModule, Role, RoleModuleAccess, UserRole, UserModuleAccess, CustomerAccount, Venue });

export { AppModule, Branch, CustomerAccount, Organization, Role, RoleModuleAccess, UserModuleAccess, UserRole, Venue };
