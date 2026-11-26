import { centralAuthClient, type CentralUser, type NewStaffAccount } from "../clients/central-auth.client.js";
import { CentralAccountNotFoundError, ConflictError, MalformedCentralAuthResponseError } from "../errors/app-errors.js";
import { logger } from "../utils/logger.js";

/**
 * The Cheche accounts behind staff (Phase 2b look-up, Phase 2e creation), shared by tenant staff and platform staff.
 * Every call here talks to auth-cheche, so callers run them before their transaction: no lock waits on the network.
 */
export type StaffAccountRequest = { mobile: string; new_account?: Omit<NewStaffAccount, "mobile"> | undefined };

async function findAccount(mobile: string): Promise<CentralUser> {
  const user = await centralAuthClient.findUserByMobile(mobile);
  if (!user) throw new CentralAccountNotFoundError(undefined, { mobile });
  return user;
}

/**
 * The Cheche account behind this mobile (Phase 2e): the existing one, or, when there is none and the Owner filled in
 * `new_account`, a new verified account with the Owner's password. A 409 (it was created meanwhile) uses the existing
 * account as it is. Always outside the transaction: no lock waits on the network.
 */
async function accountFor(input: StaffAccountRequest): Promise<{ user: CentralUser; created: boolean }> {
  const existing = await centralAuthClient.findUserByMobile(input.mobile);
  if (existing) return { user: existing, created: false };
  if (!input.new_account) throw new CentralAccountNotFoundError(undefined, { mobile: input.mobile });

  let created: CentralUser | null;
  try {
    created = await centralAuthClient.createVerifiedUser({ mobile: input.mobile, ...input.new_account });
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    return { user: await findAccount(input.mobile), created: false };
  }
  if (created) return { user: created, created: true };
  // The reply didn't name the account: look it up again.
  const lookedUp = await centralAuthClient.findUserByMobile(input.mobile);
  if (!lookedUp) throw new MalformedCentralAuthResponseError("Central Auth created the account but it can't be found by its mobile");
  return { user: lookedUp, created: true };
}

/** Names for a page of assignments, one auth-cheche call. Best effort: if it fails, profiles are null. */
async function profilesOf(userIds: string[]): Promise<Map<string, CentralUser>> {
  const unique = [...new Set(userIds)];
  try {
    return new Map((await centralAuthClient.getUsersByIds(unique)).map((user) => [user.userId, user]));
  } catch (error) {
    logger.warn({ err: error instanceof Error ? error.message : error, count: unique.length }, "Staff names could not be read from Central Auth");
    return new Map();
  }
}

export const staffAccounts = { findAccount, accountFor, profilesOf };
