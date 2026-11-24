import { z } from "zod";
import { APP_TITLE, STAFF_REFRESH_COOKIE } from "../config/app.js";
import type { RequestContract } from "../middleware/validate.js";
import * as auth from "../validators/auth.js";
import * as branch from "../validators/branch.js";
import * as customerAccount from "../validators/customer-account.js";
import * as event from "../validators/event.js";
import * as organization from "../validators/organization.js";
import * as ticketType from "../validators/ticket-type.js";
import * as venue from "../validators/venue.js";

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export type ApiOperation = {
  method: HttpMethod;
  /** OpenAPI path syntax, full path including the version prefix. */
  path: string;
  /** The exact contract object passed to validate() on the route (identity is checked by tests). */
  contract: RequestContract;
  /** components/schemas name for the body. Required exactly when contract.body exists. */
  bodyComponent?: string;
  summary: string;
  description?: string;
  tags: string[];
  auth: "staff" | "refresh-cookie" | "public";
  successStatus: 200 | 201 | 204;
};

/** The v1 operation list: one entry per route. A route without an entry fails tests/openapi.test.ts. */
export const v1Operations: readonly ApiOperation[] = [
  // --- Auth ---------------------------------------------------------------------------------
  { method: "post", path: "/v1/auth/staff/login", contract: auth.staffLoginRequest, bodyComponent: "StaffLoginRequest", summary: "Staff login with mobile or email + password (sets the HttpOnly refresh cookie)", tags: ["Auth"], auth: "public", successStatus: 200 },
  { method: "post", path: "/v1/auth/staff/refresh", contract: auth.staffRefreshRequest, bodyComponent: "StaffRefreshRequest", summary: "Renew the staff access token from the refresh cookie", tags: ["Auth"], auth: "refresh-cookie", successStatus: 200 },
  { method: "post", path: "/v1/auth/staff/logout", contract: auth.staffLogoutRequest, summary: "Sign out: clear the refresh cookie and revoke the Central Auth session (best effort; data.revoked says whether Central confirmed)", tags: ["Auth"], auth: "refresh-cookie", successStatus: 200 },
  { method: "get", path: "/v1/auth/staff/me", contract: auth.currentStaffSessionRequest, summary: "Current staff session: assignment, flat permissions, nested navigation", tags: ["Auth"], auth: "staff", successStatus: 200 },
  { method: "post", path: "/v1/auth/staff/switch-assignment", contract: auth.staffSwitchAssignmentRequest, bodyComponent: "StaffSwitchAssignmentRequest", summary: "Re-issue the staff token for another active assignment", tags: ["Auth"], auth: "staff", successStatus: 200 },

  // --- Organizations --------------------------------------------------------------------------
  { method: "post", path: "/v1/organizations", contract: organization.createOrganizationRequest, bodyComponent: "OrganizationCreateRequest", summary: "Create a tenant (platform scope). A hidden MAIN branch is always created; has_branches (default false) decides whether its staff see branches", tags: ["Organizations"], auth: "staff", successStatus: 201 },
  { method: "get", path: "/v1/organizations", contract: organization.listOrganizationsRequest, summary: "List tenants (platform scope)", tags: ["Organizations"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}", contract: organization.updateOrganizationSettingsRequest, bodyComponent: "OrganizationSettingsUpdateRequest", summary: "Edit the organization's defaults (country, timezone, default_currency). Existing events keep their own timezone", tags: ["Organizations"], auth: "staff", successStatus: 200 },
  { method: "get", path: "/v1/organizations/{organizationId}", contract: organization.getOrganizationRequest, summary: "Read one tenant", tags: ["Organizations"], auth: "staff", successStatus: 200 },

  // --- Branches -------------------------------------------------------------------------------
  { method: "post", path: "/v1/organizations/{organizationId}/branches", contract: branch.createBranchRequest, bodyComponent: "BranchCreateRequest", summary: "Create a branch", tags: ["Branches"], auth: "staff", successStatus: 201 },
  { method: "get", path: "/v1/organizations/{organizationId}/branches", contract: branch.listBranchesRequest, summary: "List branches", tags: ["Branches"], auth: "staff", successStatus: 200 },
  { method: "get", path: "/v1/organizations/{organizationId}/branches/{branchId}", contract: branch.getBranchRequest, summary: "Read a branch", tags: ["Branches"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}/branches/{branchId}", contract: branch.updateBranchRequest, bodyComponent: "BranchUpdateRequest", summary: "Update a branch (PATCH semantics)", tags: ["Branches"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}/branches/{branchId}/status", contract: branch.changeBranchStatusRequest, bodyComponent: "StatusChangeRequest", summary: "Activate or deactivate a branch", tags: ["Branches"], auth: "staff", successStatus: 200 },

  // --- Clients (customer_account: who commissions an event; not attendees) -----------------------
  { method: "post", path: "/v1/organizations/{organizationId}/customer-accounts", contract: customerAccount.createCustomerAccountRequest, bodyComponent: "CustomerAccountCreateRequest", summary: "Record a client commissioning events (an organization or an individual)", tags: ["Clients"], auth: "staff", successStatus: 201 },
  { method: "get", path: "/v1/organizations/{organizationId}/customer-accounts", contract: customerAccount.listCustomerAccountsRequest, summary: "List clients", tags: ["Clients"], auth: "staff", successStatus: 200 },
  { method: "get", path: "/v1/organizations/{organizationId}/customer-accounts/{customerAccountId}", contract: customerAccount.getCustomerAccountRequest, summary: "Read a client", tags: ["Clients"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}/customer-accounts/{customerAccountId}", contract: customerAccount.updateCustomerAccountRequest, bodyComponent: "CustomerAccountUpdateRequest", summary: "Update a client (PATCH semantics)", tags: ["Clients"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}/customer-accounts/{customerAccountId}/status", contract: customerAccount.changeCustomerAccountStatusRequest, bodyComponent: "StatusChangeRequest", summary: "Activate or deactivate a client", tags: ["Clients"], auth: "staff", successStatus: 200 },

  // --- Venues -----------------------------------------------------------------------------------
  { method: "post", path: "/v1/organizations/{organizationId}/venues", contract: venue.createVenueRequest, bodyComponent: "VenueCreateRequest", summary: "Create a reusable physical venue", tags: ["Venues"], auth: "staff", successStatus: 201 },
  { method: "get", path: "/v1/organizations/{organizationId}/venues", contract: venue.listVenuesRequest, summary: "List venues", tags: ["Venues"], auth: "staff", successStatus: 200 },
  { method: "get", path: "/v1/organizations/{organizationId}/venues/{venueId}", contract: venue.getVenueRequest, summary: "Read a venue", tags: ["Venues"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}/venues/{venueId}", contract: venue.updateVenueRequest, bodyComponent: "VenueUpdateRequest", summary: "Update a venue (PATCH semantics)", tags: ["Venues"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}/venues/{venueId}/status", contract: venue.changeVenueStatusRequest, bodyComponent: "StatusChangeRequest", summary: "Activate or deactivate a venue", tags: ["Venues"], auth: "staff", successStatus: 200 },

  // --- Events -----------------------------------------------------------------------------------
  { method: "post", path: "/v1/organizations/{organizationId}/events", contract: event.createEventRequest, bodyComponent: "EventCreateRequest", summary: "Create an event (DRAFT, UNLISTED unless PUBLIC is chosen; General Admission is added; timezone defaults to the organization's)", tags: ["Events"], auth: "staff", successStatus: 201 },
  { method: "get", path: "/v1/organizations/{organizationId}/events", contract: event.listEventsRequest, summary: "List events (display_status shows LIVE during a published event)", tags: ["Events"], auth: "staff", successStatus: 200 },
  { method: "get", path: "/v1/organizations/{organizationId}/events/{eventId}", contract: event.getEventRequest, summary: "Read an event", tags: ["Events"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}/events/{eventId}", contract: event.updateEventRequest, bodyComponent: "EventUpdateRequest", summary: "Update an event (PATCH semantics; the slug is frozen after the first publication; set registration_closes_at to stop sign-ups early)", tags: ["Events"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}/events/{eventId}/status", contract: event.changeEventStatusRequest, bodyComponent: "EventStatusChangeRequest", summary: "Publish, close or cancel an event (DRAFT→PUBLISHED|CANCELLED, PUBLISHED→CLOSED|CANCELLED)", tags: ["Events"], auth: "staff", successStatus: 200 },

  // --- Ticket types -----------------------------------------------------------------------------
  { method: "post", path: "/v1/organizations/{organizationId}/events/{eventId}/ticket-types", contract: ticketType.createTicketTypeRequest, bodyComponent: "TicketTypeCreateRequest", summary: "Add a free ticket type (its limit must fit within the event's capacity)", tags: ["Ticket types"], auth: "staff", successStatus: 201 },
  { method: "get", path: "/v1/organizations/{organizationId}/events/{eventId}/ticket-types", contract: ticketType.listTicketTypesRequest, summary: "List an event's ticket types", tags: ["Ticket types"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}/events/{eventId}/ticket-types/{ticketTypeId}", contract: ticketType.updateTicketTypeRequest, bodyComponent: "TicketTypeUpdateRequest", summary: "Update a ticket type (PATCH semantics)", tags: ["Ticket types"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}/events/{eventId}/ticket-types/{ticketTypeId}/status", contract: ticketType.changeTicketTypeStatusRequest, bodyComponent: "StatusChangeRequest", summary: "Activate or deactivate a ticket type (a published event keeps at least one active)", tags: ["Ticket types"], auth: "staff", successStatus: 200 },
];

// ---------------------------------------------------------------------------------------------
// Document builder: Zod is the single source of truth; no prototype patching, no global registry.
// ---------------------------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;
type Parameter = { name: string; in: "path" | "query"; required: boolean; schema: JsonSchema };
type Operation = {
  summary: string;
  description?: string;
  tags: string[];
  security: Array<Record<string, string[]>>;
  parameters?: Parameter[];
  requestBody?: { required: boolean; content: { "application/json": { schema: { $ref: string } } } };
  responses: Record<string, unknown>;
};
export type OpenApiDocument = {
  openapi: "3.0.3";
  info: { title: string; version: string };
  servers: Array<{ url: string }>;
  paths: Record<string, Partial<Record<HttpMethod, Operation>>>;
  components: { schemas: Record<string, JsonSchema>; securitySchemes: Record<string, unknown> };
};

/** Documents the transport (input) shape; refinements/transforms are runtime-only and described in prose. */
function toJsonSchema(schema: z.ZodType): JsonSchema {
  const converted = z.toJSONSchema(schema, { target: "openapi-3.0", io: "input", unrepresentable: "any" }) as JsonSchema;
  delete converted.$schema;
  return converted;
}

function parametersOf(location: "path" | "query", schema: z.ZodObject | undefined): Parameter[] {
  if (!schema) return [];
  const fields = Object.entries(schema.shape) as Array<[string, z.ZodType]>;
  return fields.map(([name, field]) => ({
    name,
    in: location,
    required: location === "path" || !field.safeParse(undefined).success,
    schema: toJsonSchema(field),
  }));
}

function securityFor(auth: ApiOperation["auth"]): Array<Record<string, string[]>> {
  if (auth === "staff") return [{ bearerAuth: [] }];
  if (auth === "refresh-cookie") return [{ refreshCookie: [] }];
  return [];
}

const ErrorEnvelopeSchema = z.object({
  success: z.literal(false),
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});

export function buildV1Document(): OpenApiDocument {
  const schemas: Record<string, JsonSchema> = { ErrorEnvelope: toJsonSchema(ErrorEnvelopeSchema) };
  const componentOwners = new Map<string, z.ZodType>();
  const paths: OpenApiDocument["paths"] = {};

  for (const operation of v1Operations) {
    const { contract } = operation;
    const label = `${operation.method.toUpperCase()} ${operation.path}`;

    const placeholders = [...operation.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort();
    const pathParams = Object.keys(contract.params?.shape ?? {}).sort();
    if (placeholders.join() !== pathParams.join()) {
      throw new Error(`${label}: path placeholders [${placeholders.join()}] must equal contract params [${pathParams.join()}]`);
    }
    if (Boolean(contract.body) !== Boolean(operation.bodyComponent)) {
      throw new Error(`${label}: bodyComponent must be set exactly when the contract has a body`);
    }

    let requestBody: Operation["requestBody"];
    if (contract.body && operation.bodyComponent) {
      const owner = componentOwners.get(operation.bodyComponent);
      if (owner && owner !== contract.body) throw new Error(`Component ${operation.bodyComponent} names two different schemas`);
      if (!owner) {
        componentOwners.set(operation.bodyComponent, contract.body);
        schemas[operation.bodyComponent] = toJsonSchema(contract.body);
      }
      requestBody = {
        required: !contract.body.safeParse(undefined).success,
        content: { "application/json": { schema: { $ref: `#/components/schemas/${operation.bodyComponent}` } } },
      };
    }

    const parameters = [...parametersOf("path", contract.params), ...parametersOf("query", contract.query)];
    (paths[operation.path] ??= {})[operation.method] = {
      summary: operation.summary,
      ...(operation.description ? { description: operation.description } : {}),
      tags: operation.tags,
      security: securityFor(operation.auth),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(requestBody ? { requestBody } : {}),
      responses: {
        [String(operation.successStatus)]: { description: "Success envelope: { success: true, data, meta?, message? }" },
        default: {
          description: "Error envelope",
          content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
        },
      },
    };
  }

  return {
    openapi: "3.0.3",
    info: { title: APP_TITLE, version: "1.0.0" },
    servers: [{ url: "/" }],
    paths,
    components: {
      schemas,
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        refreshCookie: { type: "apiKey", in: "cookie", name: STAFF_REFRESH_COOKIE },
      },
    },
  };
}
