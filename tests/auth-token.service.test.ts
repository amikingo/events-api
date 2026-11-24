import assert from "node:assert/strict";
import { test } from "node:test";
import jwt from "jsonwebtoken";
import { authConfig } from "../src/config/auth.js";
import { InvalidTokenError, UnsupportedTokenError } from "../src/errors/app-errors.js";
import { authTokenService, centralSessionLifetimeSeconds } from "../src/services/auth-token.service.js";
import { IDS, staffToken } from "./helpers/fixtures.js";

const PROFILE = { mobile: "+251911000000", firstname: "Test", middlename: null, lastname: "User" };
const REFRESH_TOKEN = "central-refresh-token-value";
const nowSeconds = () => Math.floor(Date.now() / 1000);

function confirmation(refreshToken = REFRESH_TOKEN): string {
  const signed = authTokenService.signStaffCentralSession({
    userId: IDS.user,
    profile: PROFILE,
    centralExpiresAt: nowSeconds() + 3 * 24 * 3600,
    refreshToken,
  });
  assert.ok(signed, "a confirmation is issued while the feature is on");
  return signed.token;
}

/** A Central Auth-style access token (HS256, iss auth_api), as auth-cheche would issue it. */
function centralAccessToken(): string {
  return jwt.sign({ user_id: IDS.user, token_type: "access", ...PROFILE }, authConfig.centralAuthJwtSecret, {
    algorithm: "HS256",
    expiresIn: 3 * 24 * 3600,
    issuer: authConfig.centralIssuer,
    subject: IDS.user,
  });
}

test("a token shaped exactly like auth-cheche's example verifies; its extra claims are ignored", () => {
  const token = jwt.sign(
    {
      user_id: IDS.user,
      firstname: "Abebe",
      middlename: "Bikila",
      lastname: "Tola",
      mobile: "+251912345678",
      service_ids: ["c8a14b3d-7a6b-4e8c-9a1d-2e3f4a5b6c7d", "f47ac10b-58cc-4372-a567-0e02b2c3d4e5"],
      token_type: "access",
      auth_role: "super_admin",
      session_id: "sess-98765-abcd",
    },
    authConfig.centralAuthJwtSecret,
    { algorithm: "HS256", expiresIn: 3 * 24 * 3600, issuer: "auth_api", subject: IDS.user },
  );

  const identity = authTokenService.verifyCentralAccessToken(token);
  assert.equal(identity.userId, IDS.user);
  assert.deepEqual(identity.profile, { mobile: "+251912345678", firstname: "Abebe", middlename: "Bikila", lastname: "Tola" });
});

test("a Central refresh token is never accepted as an access token", () => {
  const refresh = jwt.sign({ user_id: IDS.user, token_type: "refresh" }, authConfig.centralAuthJwtSecret, {
    algorithm: "HS256",
    expiresIn: 7 * 24 * 3600,
    issuer: "auth_api",
    subject: IDS.user,
  });
  assert.throws(() => authTokenService.verifyCentralAccessToken(refresh), InvalidTokenError);
});

test("confirmation lifetime: off at 0, none near Central expiry, otherwise the smaller limit", () => {
  const now = 1_000_000;
  assert.equal(centralSessionLifetimeSeconds(0, now + 86_400, now), 0, "0 turns the feature off");
  assert.equal(centralSessionLifetimeSeconds(21_600, now + 299, now), 0, "Central ends within 5 minutes");
  assert.equal(centralSessionLifetimeSeconds(21_600, now + 300, now), 0, "exactly at the margin");
  assert.equal(centralSessionLifetimeSeconds(21_600, now + 3_600, now), 3_300, "Central expiry minus 5 minutes");
  assert.equal(centralSessionLifetimeSeconds(21_600, now + 259_200, now), 21_600, "the configured cap");
});

test("a confirmation verifies only together with the refresh token it was issued with", () => {
  const token = confirmation();

  const confirmed = authTokenService.verifyStaffCentralSession(token, REFRESH_TOKEN);
  assert.equal(confirmed?.userId, IDS.user);
  assert.deepEqual(confirmed?.profile, PROFILE);

  assert.equal(authTokenService.verifyStaffCentralSession(token, "another-refresh-token"), null);
});

test("tampered, expired and foreign tokens are not accepted as confirmations", () => {
  const tampered = `${confirmation()}x`;
  const expired = jwt.sign(
    {
      token_type: "staff_central_session",
      central_exp: nowSeconds() + 3_600,
      refresh_token_hash: "0".repeat(64),
      exp: nowSeconds() - 10,
      ...PROFILE,
    },
    authConfig.appTokenSecret,
    { algorithm: "HS256", issuer: authConfig.appIssuer, audience: authConfig.appAudience, subject: IDS.user },
  );

  assert.equal(authTokenService.verifyStaffCentralSession(tampered, REFRESH_TOKEN), null);
  assert.equal(authTokenService.verifyStaffCentralSession(expired, REFRESH_TOKEN), null);
  assert.equal(authTokenService.verifyStaffCentralSession(staffToken(), REFRESH_TOKEN), null, "a staff token is not a confirmation");
});

test("with one shared key, the three token types still never pass as each other", () => {
  assert.equal(authConfig.appTokenSecret, authConfig.centralAuthJwtSecret, "this test only means something while the key is shared");
  const staff = staffToken();
  const central = centralAccessToken();
  const confirmationToken = confirmation();

  // Each is accepted where it belongs, so the signatures themselves are fine.
  assert.equal(authTokenService.verifyAppStaffToken(staff).userId, IDS.user);
  assert.equal(authTokenService.verifyCentralAccessToken(central).userId, IDS.user);

  // Refused elsewhere by issuer/token_type (UnsupportedTokenError), not by signature (InvalidTokenError).
  assert.throws(() => authTokenService.verifyCentralAccessToken(staff), UnsupportedTokenError, "staff token as Central");
  assert.throws(() => authTokenService.verifyAppStaffToken(central), UnsupportedTokenError, "Central token as staff");
  assert.throws(() => authTokenService.verifyAppStaffToken(confirmationToken), UnsupportedTokenError, "confirmation as staff");
  assert.throws(() => authTokenService.verifyCentralAccessToken(confirmationToken), UnsupportedTokenError, "confirmation as Central");

  assert.equal(authTokenService.verifyStaffCentralSession(staff, REFRESH_TOKEN), null, "staff token as confirmation");
  assert.equal(authTokenService.verifyStaffCentralSession(central, REFRESH_TOKEN), null, "Central token as confirmation");
});
