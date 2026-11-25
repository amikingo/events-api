import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import type { RequestContract, ValidateMiddleware } from "../src/middleware/validate.js";
import { buildV1Document, v1Operations } from "../src/openapi/v1.js";
import { healthRouter } from "../src/routes/health.js";
import { docsRouter } from "../src/routes/v1/docs.js";
import { call, withServer } from "./helpers/http.js";

/**
 * Contract coverage, both directions, without parsing source files:
 *  1. every mounted route validates with exactly one contract, and that contract object is documented;
 *  2. every documented operation's path really routes to a handler (HTTP probe).
 */
type Layer = { handle: unknown; route?: { methods: Record<string, boolean>; stack: Layer[] } };
type RouteInfo = { methods: string[]; contracts: RequestContract[] };

const INFRASTRUCTURE_ROUTERS = new Set<unknown>([healthRouter, docsRouter]);

function isRouter(handle: unknown): handle is { stack: Layer[] } {
  return typeof handle === "function" && Array.isArray((handle as { stack?: unknown }).stack);
}

function collectRoutes(router: { stack: Layer[] }, out: RouteInfo[] = []): RouteInfo[] {
  for (const layer of router.stack) {
    if (layer.route) {
      out.push({
        methods: Object.keys(layer.route.methods).filter((method) => layer.route?.methods[method]),
        contracts: layer.route.stack
          .map((inner) => (inner.handle as Partial<ValidateMiddleware>).contract)
          .filter((contract): contract is RequestContract => contract !== undefined),
      });
    } else if (isRouter(layer.handle) && !INFRASTRUCTURE_ROUTERS.has(layer.handle)) {
      collectRoutes(layer.handle, out);
    }
  }
  return out;
}

const app = createApp();

test("every body operation references a named component that exists", () => {
  const document = buildV1Document();
  for (const operation of v1Operations.filter((op) => op.contract.body)) {
    const requestBody = document.paths[operation.path]?.[operation.method]?.requestBody;
    assert.ok(requestBody, `${operation.path} has no requestBody`);
    assert.deepEqual(requestBody.content["application/json"]?.schema, { $ref: `#/components/schemas/${operation.bodyComponent}` });
    assert.ok(document.components.schemas[operation.bodyComponent ?? ""], `missing component ${operation.bodyComponent}`);
  }
  for (const operation of v1Operations.filter((op) => !op.contract.body && !op.fileUpload)) {
    assert.equal(document.paths[operation.path]?.[operation.method]?.requestBody, undefined, `${operation.path} must stay bodyless`);
  }
});

test("a file upload operation documents one multipart field and no JSON body", () => {
  const document = buildV1Document();
  const uploads = v1Operations.filter((op) => op.fileUpload);
  assert.ok(uploads.length > 0);
  for (const operation of uploads) {
    const requestBody = document.paths[operation.path]?.[operation.method]?.requestBody;
    assert.ok(requestBody, `${operation.path} has no requestBody`);
    assert.equal(requestBody.content["application/json"], undefined);
    const schema = requestBody.content["multipart/form-data"]?.schema as { required?: string[]; additionalProperties?: boolean } | undefined;
    assert.deepEqual(schema?.required, [operation.fileUpload?.field]);
    assert.equal(schema?.additionalProperties, false);
  }
});

test("every route is validated by a documented contract and every documented contract is routed", () => {
  const routes = collectRoutes((app as unknown as { router: { stack: Layer[] } }).router);
  assert.ok(routes.length > 0);

  for (const route of routes) {
    assert.equal(route.contracts.length, 1, `route ${route.methods.join(",")} must call validate(contract) exactly once`);
    const contract = route.contracts[0];
    const operation = v1Operations.find((op) => op.contract === contract);
    assert.ok(operation, `a ${route.methods.join(",").toUpperCase()} route uses a contract missing from openapi/v1.ts`);
    assert.ok(route.methods.includes(operation.method), `${operation.path}: method mismatch`);
  }

  const routedContracts = new Set(routes.flatMap((route) => route.contracts));
  for (const operation of v1Operations) {
    assert.ok(routedContracts.has(operation.contract), `${operation.method.toUpperCase()} ${operation.path} is documented but not routed`);
  }
  assert.equal(new Set(v1Operations.map((op) => op.contract)).size, v1Operations.length, "contracts must be unique per operation");
});

test("every documented path resolves to a mounted route", async () => {
  await withServer(app, async (baseUrl) => {
    for (const operation of v1Operations) {
      const path = operation.path.replace(/\{[^}]+\}/g, "00000000-0000-4000-8000-000000000000");
      const response = await call(baseUrl, operation.method.toUpperCase(), path);
      assert.notEqual(response.body?.error?.code, "route_not_found", `${operation.method.toUpperCase()} ${operation.path} is not mounted`);
    }
  });
});

test("Idempotency-Key is documented as a header: required on the public form, optional for staff", () => {
  const document = buildV1Document();
  const header = (path: string) =>
    (document.paths[path]?.post?.parameters ?? []).find((parameter) => parameter.in === "header" && parameter.name === "Idempotency-Key");
  assert.equal(header("/v1/public/organizations/{organizationSlug}/events/{eventSlug}/registrations")?.required, true);
  assert.equal(header("/v1/organizations/{organizationId}/events/{eventId}/registrations")?.required, false);
});
