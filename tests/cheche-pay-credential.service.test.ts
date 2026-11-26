import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import type { Transaction } from "sequelize";
import { chechePayClient } from "../src/clients/cheche-pay.client.js";
import { NotFoundError, ValidationAppError, type PaidSalesUnavailableError } from "../src/errors/app-errors.js";
import type { OrganizationChechePayCredentialRow } from "../src/models/organization-cheche-pay-credential.js";
import { organizationChechePayCredentialRepository } from "../src/repositories/organization-cheche-pay-credential.repository.js";
import { organizationRepository } from "../src/repositories/organization.repository.js";
import { chechePayCredentialService } from "../src/services/cheche-pay-credential.service.js";
import { transactionManager } from "../src/services/helpers.js";
import { secretBox } from "../src/utils/secret-box.js";
import { chechePayCredentialRow, IDS, organizationRow } from "./helpers/fixtures.js";

/** An organizer's Cheche Pay keys (Phase 7 step 3b), against an in-memory row and the real encryption (test key). */
const FAKE_TX = { id: "fake-transaction" } as unknown as Transaction;
let row: OrganizationChechePayCredentialRow | null;

function arrange(initial: OrganizationChechePayCredentialRow | null = null) {
  row = initial;
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
  mock.method(organizationRepository, "findById", async () => organizationRow());
  mock.method(organizationChechePayCredentialRepository, "findByOrganization", async () => (row ? { ...row } : null));
  const create = mock.method(organizationChechePayCredentialRepository, "create", async (values: Partial<OrganizationChechePayCredentialRow>) => {
    row = chechePayCredentialRow({ ...values });
    return row;
  });
  const update = mock.method(organizationChechePayCredentialRepository, "updateByOrganization", async (_o: string, values: Partial<OrganizationChechePayCredentialRow>) => {
    row = { ...(row as OrganizationChechePayCredentialRow), ...values };
  });
  mock.method(organizationChechePayCredentialRepository, "deleteByOrganization", async () => {
    const had = row !== null;
    row = null;
    return had;
  });
  return { create, update };
}

afterEach(() => mock.restoreAll());

test("the first save needs a secret key; it is stored encrypted and the reply is masked, with the webhook URL to give Cheche Pay", async () => {
  arrange();
  await assert.rejects(chechePayCredentialService.save(IDS.orgA, { webhook_secret: "whsec_abcdefgh" }, IDS.user), ValidationAppError);
  const saved = await chechePayCredentialService.save(IDS.orgA, { secret_key: "sk_test_abcdef12", webhook_secret: "whsec_abcdefgh" }, IDS.user);
  assert.deepEqual(
    [saved.configured, saved.is_active, saved.key_mode, saved.secret_key_masked, saved.has_webhook_secret, saved.paid_sales_available],
    [true, true, "test", "sk_test_••••ef12", true, true],
  );
  assert.equal(saved.webhook_url, `https://api.events.example.test/v1/payments/cheche/webhook/${IDS.orgA}`);
  assert.ok(!JSON.stringify(saved).includes("sk_test_abcdef12") && !JSON.stringify(saved).includes("whsec_abcdefgh"), "never returned");
  assert.ok(row && !row.secret_key_encrypted.includes("sk_test"), "never stored in plain text");
  assert.equal(secretBox.decrypt(row.secret_key_encrypted), "sk_test_abcdef12");
});

test("a publishable key or a malformed one is refused with a message saying why; a short webhook secret too", async () => {
  arrange();
  const issueCode = (error: unknown) => ((error as ValidationAppError).details as { issues: Array<{ code: string }> }).issues[0]?.code;
  await assert.rejects(chechePayCredentialService.save(IDS.orgA, { secret_key: "pk_test_abcdef12" }, IDS.user), (error: unknown) => issueCode(error) === "publishable_key");
  await assert.rejects(chechePayCredentialService.save(IDS.orgA, { secret_key: "abc" }, IDS.user), (error: unknown) => issueCode(error) === "invalid_secret_key");
  await assert.rejects(chechePayCredentialService.save(IDS.orgA, { secret_key: "sk_live_abcdef12", webhook_secret: "short" }, IDS.user), (error: unknown) => issueCode(error) === "invalid_webhook_secret");
});

test("later saves change only what is sent: a new key replaces the old, null clears the webhook secret, is_active switches", async () => {
  const { update } = arrange(chechePayCredentialRow({ webhook_secret_encrypted: secretBox.encrypt("whsec_abcdefgh") }));
  const off = await chechePayCredentialService.save(IDS.orgA, { is_active: false }, IDS.user);
  assert.deepEqual([off.is_active, off.paid_sales_available, off.has_webhook_secret], [false, false, true]);
  const cleared = await chechePayCredentialService.save(IDS.orgA, { webhook_secret: null }, IDS.user);
  assert.equal(cleared.has_webhook_secret, false);
  const live = await chechePayCredentialService.save(IDS.orgA, { secret_key: "sk_live_newkey99" }, IDS.user);
  assert.deepEqual([live.key_mode, live.secret_key_masked], ["live", "sk_live_••••ey99"]);
  assert.deepEqual(Object.keys(update.mock.calls[0]?.arguments[1] ?? {}).sort(), ["is_active", "updated_by"]);
});

test("resolve decrypts for payment calls: switched-off keys only when asked; requireForSale and assertAvailable say why sales are off", async () => {
  arrange(chechePayCredentialRow({ secret_key_encrypted: secretBox.encrypt("sk_test_abcdef12"), is_active: false }));
  assert.equal(await chechePayCredentialService.resolve(IDS.orgA), null);
  assert.deepEqual(await chechePayCredentialService.resolve(IDS.orgA, { includeInactive: true }), { secretKey: "sk_test_abcdef12", webhookSecret: null, mode: "test" });
  const reason = (error: unknown) => (error as PaidSalesUnavailableError).details as { reason: string };
  await assert.rejects(chechePayCredentialService.requireForSale(IDS.orgA), (error: unknown) => reason(error).reason === "NO_CHECHE_PAY_KEYS");
  await assert.rejects(chechePayCredentialService.assertAvailable(IDS.orgA), (error: unknown) => reason(error).reason === "NO_CHECHE_PAY_KEYS");
  mock.restoreAll();
  arrange(chechePayCredentialRow({ secret_key_encrypted: secretBox.encrypt("sk_test_abcdef12") }));
  assert.equal((await chechePayCredentialService.requireForSale(IDS.orgA)).secretKey, "sk_test_abcdef12");
  await chechePayCredentialService.assertAvailable(IDS.orgA);
});

test("check asks Cheche Pay with the saved key; remove deletes the keys, and removing none is 404", async () => {
  arrange(chechePayCredentialRow({ secret_key_encrypted: secretBox.encrypt("sk_test_abcdef12") }));
  const checkKey = mock.method(chechePayClient, "checkKey", async () => ({ ok: true, reason: "KEY_ACCEPTED" as const, provider_status: 404 }));
  const checked = await chechePayCredentialService.check(IDS.orgA);
  assert.deepEqual([checked.ok, checked.reason, checked.key_mode], [true, "KEY_ACCEPTED", "test"]);
  assert.equal(checkKey.mock.calls[0]?.arguments[0], "sk_test_abcdef12");
  assert.equal((await chechePayCredentialService.remove(IDS.orgA)).configured, false);
  await assert.rejects(chechePayCredentialService.remove(IDS.orgA), NotFoundError);
  await assert.rejects(chechePayCredentialService.check(IDS.orgA), NotFoundError);
});
