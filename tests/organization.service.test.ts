import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { Transaction } from "sequelize";
import { ValidationAppError } from "../src/errors/app-errors.js";
import { branchRepository } from "../src/repositories/branch.repository.js";
import { organizationRepository } from "../src/repositories/organization.repository.js";
import { transactionManager } from "../src/services/helpers.js";
import { organizationService } from "../src/services/organization.service.js";
import { organizationCreateSchema } from "../src/validators/organization.js";
import { branchRow, organizationRow } from "./helpers/fixtures.js";

const FAKE_TX = { id: "fake-transaction" } as unknown as Transaction;

beforeEach(() => {
  // The service runs its real logic against a fake transaction and mocked repositories: no database needed.
  mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
  mock.method(organizationRepository, "findBySlug", async () => null);
  mock.method(organizationRepository, "create", async () => organizationRow());
  mock.method(branchRepository, "create", async () => branchRow());
});
afterEach(() => mock.restoreAll());

/** Creates an organization and returns the slug the service saved. */
async function savedSlug(name: string, slug?: string): Promise<string | undefined> {
  const create = mock.method(organizationRepository, "create", async () => organizationRow());
  const organization = slug === undefined ? { name, description: undefined } : { name, slug, description: undefined };
  await organizationService.createOrganization({ organization }, null);
  return create.mock.calls[0]?.arguments[0]?.slug;
}

test("a name with no Latin letters or digits needs a slug: clear 400, no database work", async () => {
  const run = mock.method(transactionManager, "run", async (work: (tx: Transaction) => Promise<unknown>) => work(FAKE_TX));
  for (const name of ["ሰላም ኢቨንትስ", "ሀ A"]) {
    await assert.rejects(
      organizationService.createOrganization({ organization: { name, description: undefined } }, null),
      (error: unknown) => {
        assert.ok(error instanceof ValidationAppError, name);
        assert.equal(error.statusCode, 400);
        assert.deepEqual(
          (error.details as { issues: Array<{ path: string; code: string }> }).issues.map(({ path, code }) => ({ path, code })),
          [{ path: "body.organization.slug", code: "slug_required" }],
        );
        return true;
      },
    );
  }
  assert.equal(run.mock.callCount(), 0, "no transaction is opened");
});

test("a Latin name becomes a slug, accents included; a slug the client sends is used as is", async () => {
  assert.equal(await savedSlug("Selam Events PLC"), "selam-events-plc");
  assert.equal(await savedSlug("Café Addis"), "cafe-addis");
  assert.equal(await savedSlug("ሰላም ኢቨንትስ", "selam-events"), "selam-events");
});

test("a long name is cut to 120 characters without a trailing hyphen, and passes the slug validator", async () => {
  const slug = await savedSlug(`${"a".repeat(119)} events`);
  assert.equal(slug, "a".repeat(119));
  assert.ok(
    organizationCreateSchema.safeParse({ organization: { name: "Long", slug } }).success,
    "the API would accept this slug if a client sent it",
  );
});
