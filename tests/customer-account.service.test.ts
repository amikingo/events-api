import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { Transaction } from "sequelize";
import { NotFoundError, ValidationAppError } from "../src/errors/app-errors.js";
import { customerAccountRepository } from "../src/repositories/customer-account.repository.js";
import { organizationRepository } from "../src/repositories/organization.repository.js";
import { customerAccountService } from "../src/services/customer-account.service.js";
import { transactionManager } from "../src/services/helpers.js";
import { customerAccountRow, IDS, organizationRow } from "./helpers/fixtures.js";

/** The client service against mocked repositories and a fake transaction: no database needed. */
const FAKE_TX = { id: "fake-transaction" } as unknown as Transaction;
/** Validated input always carries the transformed optional keys; undefined means "not sent". */
const NOT_SENT = { type: undefined, primary_contact_name: undefined, primary_contact_email: undefined, primary_contact_phone: undefined };

beforeEach(() => {
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
  mock.method(organizationRepository, "findById", async () => organizationRow());
});
afterEach(() => mock.restoreAll());

test("a new client defaults to an active ORGANIZATION, scoped to the organization and the transaction", async () => {
  const create = mock.method(customerAccountRepository, "create", async () => customerAccountRow());

  await customerAccountService.createCustomerAccount(IDS.orgA, { ...NOT_SENT, name: "ABC Bank", type: "Corporate" }, IDS.user);

  const [values, options] = create.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(
    [values?.organization_id, values?.name, values?.kind, values?.type, values?.primary_contact_email, values?.is_active, values?.created_by],
    [IDS.orgA, "ABC Bank", "ORGANIZATION", "Corporate", null, true, IDS.user],
  );
  assert.deepEqual(options, { transaction: FAKE_TX });
});

test("switching a client to INDIVIDUAL while a sector type is stored is refused, unless the type is cleared", async () => {
  mock.method(customerAccountRepository, "findByOrganizationAndId", async () => customerAccountRow({ type: "Corporate" }));
  const update = mock.method(customerAccountRepository, "updateByOrganizationAndId", async () => customerAccountRow({ kind: "INDIVIDUAL", type: null }));

  await assert.rejects(
    customerAccountService.updateCustomerAccount(IDS.orgA, IDS.customerAccount, { ...NOT_SENT, kind: "INDIVIDUAL" }, IDS.user),
    (error: unknown) =>
      error instanceof ValidationAppError &&
      (error.details as { issues: Array<{ code: string }> }).issues[0]?.code === "type_not_allowed_for_individual",
  );
  assert.equal(update.mock.callCount(), 0);

  await customerAccountService.updateCustomerAccount(IDS.orgA, IDS.customerAccount, { ...NOT_SENT, kind: "INDIVIDUAL", type: null }, IDS.user);
  const [organizationId, customerAccountId, values, options] = update.mock.calls[0]?.arguments ?? [];
  assert.deepEqual([organizationId, customerAccountId], [IDS.orgA, IDS.customerAccount]);
  assert.deepEqual(values, { kind: "INDIVIDUAL", type: null, updated_by: IDS.user });
  assert.deepEqual(options, { transaction: FAKE_TX });
});

test("an update persists only allow-listed fields with PATCH semantics", async () => {
  mock.method(customerAccountRepository, "findByOrganizationAndId", async () => customerAccountRow());
  const update = mock.method(customerAccountRepository, "updateByOrganizationAndId", async () => customerAccountRow());

  // name omitted (keep), contact email null (clear), contact name supplied (replace)
  await customerAccountService.updateCustomerAccount(
    IDS.orgA,
    IDS.customerAccount,
    { ...NOT_SENT, primary_contact_name: "Meron", primary_contact_email: null },
    IDS.user,
  );

  const [, , values] = update.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(values, { primary_contact_name: "Meron", primary_contact_email: null, updated_by: IDS.user });
});

test("a client of another organization is not found: the id alone is never a tenant boundary", async () => {
  const find = mock.method(customerAccountRepository, "findByOrganizationAndId", async () => null);

  await assert.rejects(customerAccountService.getCustomerAccount(IDS.orgB, IDS.customerAccount), NotFoundError);
  assert.deepEqual(find.mock.calls[0]?.arguments.slice(0, 2), [IDS.orgB, IDS.customerAccount]);
});
