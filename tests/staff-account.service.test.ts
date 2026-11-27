import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { centralAuthClient, type CentralProfile } from "../src/clients/central-auth.client.js";
import { CentralAuthRefusedError, CentralAuthUnavailableError, InvalidCodeError, InvalidCredentialsError, ValidationAppError } from "../src/errors/app-errors.js";
import type { StaffAuthContext } from "../src/middleware/authentication.js";
import { userRoleRepository } from "../src/repositories/user-role.repository.js";
import { authTokenService } from "../src/services/auth-token.service.js";
import { staffAccountService } from "../src/services/staff-account.service.js";
import { assignment, IDS, roleRow } from "./helpers/fixtures.js";

/** A staff member's own account (Phase 10) against a fake auth-cheche and fake assignments: no network, no database. */
const MOBILE = "+251911223344";
const EXPIRES_AT = Math.floor(Date.now() / 1000) + 600;
const AUTH: StaffAuthContext = {
  kind: "staff",
  userId: IDS.user,
  assignmentId: IDS.assignment,
  roleId: IDS.roleA,
  organizationId: IDS.orgA,
  branchId: null,
  profile: { mobile: MOBILE, firstname: "Hana", middlename: null, lastname: "Bekele" },
  expiresAt: EXPIRES_AT,
};
const PROFILE: CentralProfile = {
  userId: IDS.user,
  mobile: MOBILE,
  firstname: "Hana",
  middlename: null,
  lastname: "Bekele",
  email: "hana@example.et",
  sex: "FEMALE",
  date_of_birth: "1995-03-04",
};
const SAME_REPLY = { sent: true, message: "If this mobile has staff access, a code has been sent to it." };

afterEach(() => mock.restoreAll());

// --- Own names -------------------------------------------------------------------------------------

test("own names: only the changed names are sent, and the reply carries a staff token with the new names (same assignment, same expiry)", async () => {
  mock.method(centralAuthClient, "getUserProfile", async () => PROFILE);
  const update = mock.method(centralAuthClient, "updateUserProfile", async (_id: string, _patch: unknown) => undefined);

  const reply = await staffAccountService.updateOwnNames(AUTH, { firstname: "Hanna", middlename: "Alemu", lastname: "Bekele" });

  assert.deepEqual(update.mock.calls[0]?.arguments, [IDS.user, { firstname: "Hanna", middlename: "Alemu" }], "the unchanged last name isn't sent");
  assert.equal(reply.changed, true);
  assert.deepEqual(reply.profile, { firstname: "Hanna", middlename: "Alemu", lastname: "Bekele", mobile: MOBILE, email: "hana@example.et" });
  const token = authTokenService.verifyAppStaffToken(reply.access_token);
  assert.equal(token.assignmentId, IDS.assignment);
  assert.equal(token.organizationId, IDS.orgA);
  assert.deepEqual(token.profile, { mobile: MOBILE, firstname: "Hanna", middlename: "Alemu", lastname: "Bekele" });
  assert.ok(token.expiresAt <= EXPIRES_AT, "never outlives the session it replaces");
});

test("own names: nothing changed sends nothing; middlename \"\" clears it and left out keeps it", async () => {
  mock.method(centralAuthClient, "getUserProfile", async () => ({ ...PROFILE, middlename: "Alemu" }));
  const update = mock.method(centralAuthClient, "updateUserProfile", async (_id: string, _patch: unknown) => undefined);

  const same = await staffAccountService.updateOwnNames(AUTH, { firstname: " Hana ", lastname: "Bekele" });
  assert.equal(update.mock.callCount(), 0);
  assert.equal(same.changed, false);
  assert.equal(same.profile.middlename, "Alemu", "left out keeps it");

  const cleared = await staffAccountService.updateOwnNames(AUTH, { firstname: "Hana", middlename: "", lastname: "Bekele" });
  assert.deepEqual(update.mock.calls[0]?.arguments[1], { middlename: "" });
  assert.equal(cleared.profile.middlename, null);
});

test("own names: a refusal by auth-cheche stays 409 central_auth_refused, never a 401", async () => {
  mock.method(centralAuthClient, "getUserProfile", async () => PROFILE);
  mock.method(centralAuthClient, "updateUserProfile", async () => {
    throw new CentralAuthRefusedError();
  });
  await assert.rejects(staffAccountService.updateOwnNames(AUTH, { firstname: "X", lastname: "Bekele" }), CentralAuthRefusedError);
});

// --- Change password -------------------------------------------------------------------------------

test("change password: the old password is checked by signing in, then changed with that session's token", async () => {
  const login = mock.method(centralAuthClient, "passwordLogin", async (_input: unknown) => ({ accessToken: "central-access", refreshToken: "central-refresh", refreshExpiresIn: null }));
  const update = mock.method(centralAuthClient, "updatePassword", async (..._args: unknown[]) => undefined);

  assert.deepEqual(await staffAccountService.changePassword(AUTH, { old_password: "old-secret", new_password: "new-secret-1" }), { updated: true });
  assert.deepEqual(login.mock.calls[0]?.arguments[0], { mobile: MOBILE, password: "old-secret" });
  assert.deepEqual(update.mock.calls[0]?.arguments, [IDS.user, "central-access", "old-secret", "new-secret-1"]);
});

test("change password: a wrong old password is 400 wrong_password on body.old_password (not a lost session), and nothing changes", async () => {
  mock.method(centralAuthClient, "passwordLogin", async () => {
    throw new InvalidCredentialsError();
  });
  const update = mock.method(centralAuthClient, "updatePassword", async () => undefined);

  await assert.rejects(staffAccountService.changePassword(AUTH, { old_password: "wrong", new_password: "new-secret-1" }), (error: unknown) => {
    assert.ok(error instanceof ValidationAppError);
    assert.deepEqual((error.details as { issues: { path: string; code: string }[] }).issues.map(({ path, code }) => ({ path, code })), [{ path: "body.old_password", code: "wrong_password" }]);
    return true;
  });
  assert.equal(update.mock.callCount(), 0);
});

test("change password: auth-cheche being down stays 503", async () => {
  mock.method(centralAuthClient, "passwordLogin", async () => {
    throw new CentralAuthUnavailableError();
  });
  await assert.rejects(staffAccountService.changePassword(AUTH, { old_password: "old-secret", new_password: "new-secret-1" }), CentralAuthUnavailableError);
});

// --- Forgot password -------------------------------------------------------------------------------

function staffLookup(options: { account?: boolean; assignments?: ReturnType<typeof assignment>[] } = {}) {
  return {
    find: mock.method(centralAuthClient, "findUserByMobile", async (_mobile: string) =>
      options.account === false ? null : { userId: IDS.user, mobile: MOBILE, firstname: "Hana", middlename: null, lastname: "Bekele" },
    ),
    assignments: mock.method(userRoleRepository, "listActiveAssignmentsByUser", async (_userId: string) => options.assignments ?? [assignment()]),
    send: mock.method(centralAuthClient, "sendCode", async (_mobile: string) => undefined),
  };
}

test("forgot password: a staff mobile (normalized) gets a code", async () => {
  const fakes = staffLookup();
  assert.deepEqual(await staffAccountService.requestPasswordReset({ mobile: "0911223344" }), SAME_REPLY);
  assert.deepEqual(fakes.find.mock.calls[0]?.arguments, [MOBILE]);
  assert.deepEqual(fakes.send.mock.calls[0]?.arguments, [MOBILE]);
});

test("forgot password: no account, no usable assignment, a bad mobile and a failure all get the same reply and no code", async () => {
  const noAccount = staffLookup({ account: false });
  assert.deepEqual(await staffAccountService.requestPasswordReset({ mobile: MOBILE }), SAME_REPLY);
  assert.equal(noAccount.send.mock.callCount(), 0);
  mock.restoreAll();

  const inactiveRole = staffLookup({ assignments: [assignment({ role: roleRow({ is_active: false }) })] });
  assert.deepEqual(await staffAccountService.requestPasswordReset({ mobile: MOBILE }), SAME_REPLY);
  assert.equal(inactiveRole.send.mock.callCount(), 0, "an assignment that can't be used isn't staff access");
  mock.restoreAll();

  const badMobile = staffLookup();
  assert.deepEqual(await staffAccountService.requestPasswordReset({ mobile: "12" }), SAME_REPLY);
  assert.equal(badMobile.find.mock.callCount(), 0);
  mock.restoreAll();

  staffLookup();
  mock.method(centralAuthClient, "sendCode", async () => {
    throw new CentralAuthUnavailableError();
  });
  assert.deepEqual(await staffAccountService.requestPasswordReset({ mobile: MOBILE }), SAME_REPLY, "a failure doesn't reveal staff access");
});

test("reset password: a staff mobile resets with the code; a mobile without staff access is invalid_code without asking auth-cheche", async () => {
  staffLookup();
  const reset = mock.method(centralAuthClient, "resetPassword", async (_input: unknown) => undefined);
  assert.deepEqual(await staffAccountService.resetPassword({ mobile: "0911223344", otp: "123456", new_password: "new-secret-1" }), { reset: true });
  assert.deepEqual(reset.mock.calls[0]?.arguments[0], { mobile: MOBILE, otp: "123456", newPassword: "new-secret-1" });
  mock.restoreAll();

  staffLookup({ assignments: [] });
  const refused = mock.method(centralAuthClient, "resetPassword", async () => undefined);
  await assert.rejects(staffAccountService.resetPassword({ mobile: MOBILE, otp: "123456", new_password: "new-secret-1" }), InvalidCodeError);
  assert.equal(refused.mock.callCount(), 0);
});
