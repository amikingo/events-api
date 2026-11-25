import { Router } from "express";
import { personController } from "../../controllers/person.controller.js";
import { requireStaffAuthentication } from "../../middleware/authentication.js";
import { organizationScopeFromParams, requirePermission } from "../../middleware/permission.js";
import { validate } from "../../middleware/validate.js";
import { MODULE_CODES } from "../../utils/module-codes.js";
import { changePersonStatusRequest, createPersonRequest, getPersonRequest, listPersonsRequest, updatePersonRequest } from "../../validators/person.js";

/** Mounted at /v1/organizations/:organizationId/persons (mergeParams exposes :organizationId). Guest profiles. */
export const personsRouter = Router({ mergeParams: true });

// Every route reads top to bottom: authenticate -> validate -> authorize -> controller.
personsRouter.post(
  "/",
  requireStaffAuthentication,
  validate(createPersonRequest),
  requirePermission({ moduleCode: MODULE_CODES.REGISTRATIONS, action: "create", scope: organizationScopeFromParams }),
  personController.createPerson,
);

personsRouter.get(
  "/",
  requireStaffAuthentication,
  validate(listPersonsRequest),
  requirePermission({ moduleCode: MODULE_CODES.REGISTRATIONS, action: "view", scope: organizationScopeFromParams }),
  personController.listPersons,
);

personsRouter.get(
  "/:personId",
  requireStaffAuthentication,
  validate(getPersonRequest),
  requirePermission({ moduleCode: MODULE_CODES.REGISTRATIONS, action: "view", scope: organizationScopeFromParams }),
  personController.getPerson,
);

personsRouter.patch(
  "/:personId",
  requireStaffAuthentication,
  validate(updatePersonRequest),
  requirePermission({ moduleCode: MODULE_CODES.REGISTRATIONS, action: "update", scope: organizationScopeFromParams }),
  personController.updatePerson,
);

personsRouter.patch(
  "/:personId/status",
  requireStaffAuthentication,
  validate(changePersonStatusRequest),
  requirePermission({ moduleCode: MODULE_CODES.REGISTRATIONS, action: "update", scope: organizationScopeFromParams }),
  personController.changePersonStatus,
);
