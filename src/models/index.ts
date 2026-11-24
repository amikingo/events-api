import { AppModule } from "./module.js";
import { Branch } from "./branch.js";
import { initAssociations } from "./init-associations.js";
import { Organization } from "./organization.js";
import { Role } from "./role.js";
import { RoleModuleAccess } from "./role-module-access.js";
import { UserModuleAccess } from "./user-module-access.js";
import { UserRole } from "./user-role.js";

initAssociations({ Organization, Branch, AppModule, Role, RoleModuleAccess, UserRole, UserModuleAccess });

export { AppModule, Branch, Organization, Role, RoleModuleAccess, UserModuleAccess, UserRole };
