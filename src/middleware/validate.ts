import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { z } from "zod";
import { ValidationAppError } from "../errors/app-errors.js";

/**
 * One request contract per endpoint. The SAME object is passed to:
 *   - validate(contract)            on the route
 *   - getValidated(req, contract)   in the controller (typed input)
 *   - the OpenAPI operation list    (documentation + route coverage test)
 */
export type RequestContract = {
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodType;
  /**
   * Request headers this endpoint reads (lower-case names, e.g. "idempotency-key"). Use z.object, never a strict or
   * loose object: every other header (Authorization, cookies, …) is dropped from the validated input.
   */
  headers?: z.ZodObject;
};

type Out<S> = S extends z.ZodType ? z.output<S> : undefined;

export type ValidatedInput<C extends RequestContract> = {
  params: Out<C["params"]>;
  query: Out<C["query"]>;
  body: Out<C["body"]>;
  headers: Out<C["headers"]>;
};

export type ValidateMiddleware = RequestHandler & { readonly contract: RequestContract };

const PARTS = ["params", "query", "body", "headers"] as const;

export function validate<C extends RequestContract>(contract: C): ValidateMiddleware {
  const middleware = (req: Request, _res: Response, next: NextFunction): void => {
    const validated: { params?: unknown; query?: unknown; body?: unknown; headers?: unknown } = {};
    const issues: Array<{ path: string; message: string; code: string }> = [];

    for (const part of PARTS) {
      const schema = contract[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part]);
      if (result.success) {
        validated[part] = result.data;
      } else {
        for (const issue of result.error.issues) {
          issues.push({ path: [part, ...issue.path.map(String)].join("."), message: issue.message, code: issue.code });
        }
      }
    }

    if (issues.length > 0) {
      next(new ValidationAppError("Request validation failed", { issues }));
      return;
    }

    req.validated = validated;
    next();
  };

  return Object.assign(middleware, { contract });
}

/** Typed access to the parsed input. Parts not declared in the contract are `undefined`. */
export function getValidated<C extends RequestContract>(req: Request, _contract: C): ValidatedInput<C> {
  if (!req.validated) {
    // Programming error: the route forgot validate(contract). Fail loudly (500), never silently.
    throw new Error("getValidated() called on a route without validate()");
  }
  return req.validated as ValidatedInput<C>;
}
