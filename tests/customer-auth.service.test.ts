import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { centralAuthClient, type CentralUser } from "../src/clients/central-auth.client.js";
import { CentralAuthUnavailableError, ValidationAppError } from "../src/errors/app-errors.js";
import type { CentralIdentity } from "../src/services/auth-token.service.js";
import { customerAuthService } from "../src/services/customer-auth.service.js";

/** Where a guest's mobile comes from (Phase 6): the account, never the browser. auth-cheche is a test double. */
const GUEST_ID = "d1111111-1111-4111-8111-111111111111";
const identity = (mobile: string | null): CentralIdentity => ({
  userId: GUEST_ID,
  profile: { mobile, firstname: "Hana", middlename: null, lastname: "Bekele" },
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
});
const user = (mobile: string | null): CentralUser => ({ userId: GUEST_ID, mobile, firstname: "Hana", middlename: null, lastname: "Bekele" });

afterEach(() => mock.restoreAll());

test("the token's mobile is used (normalized to +251…) and auth-cheche isn't asked", async () => {
  const lookup = mock.method(centralAuthClient, "getUsersByIds", async () => []);
  assert.equal(await customerAuthService.accountMobile(identity("0911223344"), { required: true }), "+251911223344");
  assert.equal(lookup.mock.callCount(), 0);
});

test("without a mobile in the token, it comes from auth-cheche by user id (specific_users)", async () => {
  const lookup = mock.method(centralAuthClient, "getUsersByIds", async (_ids: readonly string[]) => [user("+251911223344")]);
  assert.equal(await customerAuthService.accountMobile(identity(null), { required: true }), "+251911223344");
  assert.deepEqual(lookup.mock.calls[0]?.arguments[0], [GUEST_ID]);
});

test("when registering, an account without any mobile is refused, and an unreachable auth-cheche is an error, not a guess", async () => {
  mock.method(centralAuthClient, "getUsersByIds", async () => [user(null)]);
  await assert.rejects(customerAuthService.accountMobile(identity(null), { required: true }), ValidationAppError);
  mock.restoreAll();

  mock.method(centralAuthClient, "getUsersByIds", async () => {
    throw new CentralAuthUnavailableError();
  });
  await assert.rejects(customerAuthService.accountMobile(identity(null), { required: true }), CentralAuthUnavailableError);
  assert.equal(await customerAuthService.accountMobile(identity(null), { required: false }), null, "a session still works without it");
});

// --- Own names (Phase 10) ----------------------------------------------------------------------------

test("a guest changes their own names: only changed names go to auth-cheche, and the reply is the new profile", async () => {
  const profile = { userId: GUEST_ID, mobile: "+251911223344", firstname: "Hana", middlename: "Alemu", lastname: "Bekele", email: null, sex: null, date_of_birth: null };
  mock.method(centralAuthClient, "getUserProfile", async () => profile);
  const update = mock.method(centralAuthClient, "updateUserProfile", async (_id: string, _patch: unknown) => undefined);
  const auth = { kind: "customer" as const, token: "central-token", ...identity("+251911223344") };

  const reply = await customerAuthService.updateOwnNames(auth, { firstname: "Hanna", middlename: "", lastname: "Bekele" });
  assert.deepEqual(update.mock.calls[0]?.arguments, [GUEST_ID, { firstname: "Hanna", middlename: "" }]);
  assert.deepEqual(reply, { id: GUEST_ID, mobile: "+251911223344", firstname: "Hanna", middlename: null, lastname: "Bekele" });

  await customerAuthService.updateOwnNames(auth, { firstname: "Hana", lastname: "Bekele" });
  assert.equal(update.mock.callCount(), 1, "nothing changed, nothing sent");
});
