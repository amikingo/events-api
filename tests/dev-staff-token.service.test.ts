import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { authConfig } from "../src/config/auth.js";
import { StaffAssignmentNotFoundError, StaffContextRequiredError } from "../src/errors/app-errors.js";
import { userRoleRepository } from "../src/repositories/user-role.repository.js";
import { authTokenService } from "../src/services/auth-token.service.js";
import { devStaffTokenService } from "../src/services/dev-staff-token.service.js";
import { assignment, IDS } from "./helpers/fixtures.js";

/** The development-only staff token, against a mocked assignment repository. */
const SECOND_ASSIGNMENT = "66666666-6666-4666-8666-666666666662";
/** Always calls through the service object (the project's mocking convention). */
const issue = (input: Parameters<typeof devStaffTokenService.issueDevelopmentStaffToken>[0]) =>
  devStaffTokenService.issueDevelopmentStaffToken(input);

afterEach(() => mock.restoreAll());

test("refused unless NODE_ENV is development, before any database read", async () => {
  const load = mock.method(userRoleRepository, "listActiveAssignmentsByUser", async () => [assignment()]);

  for (const environment of ["production", "test"] as const) {
    await assert.rejects(issue({ userId: IDS.user, environment }), /only when NODE_ENV=development/, environment);
  }
  assert.equal(load.mock.callCount(), 0);
});

test("signs a normal staff token for the person's only assignment", async () => {
  mock.method(userRoleRepository, "listActiveAssignmentsByUser", async () => [assignment()]);

  const result = await issue({ userId: IDS.user, environment: "development" });

  const identity = authTokenService.verifyAppStaffToken(result.accessToken);
  assert.deepEqual([identity.userId, identity.assignmentId, identity.organizationId], [IDS.user, IDS.assignment, IDS.orgA]);
  assert.equal(result.assignment.id, IDS.assignment);
  assert.ok(result.expiresIn > 0 && result.expiresIn <= authConfig.appTokenTtlSeconds, "the normal staff token lifetime");
});

test("with several assignments, an assignment id is required and must be one of them", async () => {
  mock.method(userRoleRepository, "listActiveAssignmentsByUser", async () => [assignment(), assignment({ id: SECOND_ASSIGNMENT })]);

  await assert.rejects(issue({ userId: IDS.user, environment: "development" }), StaffContextRequiredError);

  const chosen = await issue({ userId: IDS.user, assignmentId: SECOND_ASSIGNMENT, environment: "development" });
  assert.equal(authTokenService.verifyAppStaffToken(chosen.accessToken).assignmentId, SECOND_ASSIGNMENT);

  await assert.rejects(
    issue({ userId: IDS.user, assignmentId: "66666666-6666-4666-8666-666666666669", environment: "development" }),
    StaffAssignmentNotFoundError,
  );
});

test("a person with no active assignment gets no token", async () => {
  mock.method(userRoleRepository, "listActiveAssignmentsByUser", async () => []);
  await assert.rejects(issue({ userId: IDS.user, environment: "development" }), StaffAssignmentNotFoundError);
});
