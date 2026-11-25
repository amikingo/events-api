import { z } from "zod";
import { APP_TITLE, STAFF_REFRESH_COOKIE } from "../config/app.js";
import type { RequestContract } from "../middleware/validate.js";
import * as auth from "../validators/auth.js";
import * as branch from "../validators/branch.js";
import * as customerAccount from "../validators/customer-account.js";
import * as event from "../validators/event.js";
import * as organization from "../validators/organization.js";
import * as person from "../validators/person.js";
import * as publicEvent from "../validators/public-event.js";
import * as publicRegistration from "../validators/public-registration.js";
import * as registration from "../validators/registration.js";
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
  /** A multipart/form-data upload of one file in this field (parsed by multer on the route, not by validate()). */
  fileUpload?: { field: string; description: string };
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
  { method: "put", path: "/v1/organizations/{organizationId}/events/{eventId}/cover", contract: event.setEventCoverRequest, fileUpload: { field: "file", description: "JPEG, PNG or WebP, up to 5 MB, checked by its contents. One file and no other fields." }, summary: "Upload and attach the event's cover image (replaces the current cover; cover.url in the reply is a path under /assets/uploads)", description: "Errors: 400 missing file, extra file or extra field; 413 over 5 MB; 415 not a JPEG, PNG or WebP; 409 CLOSED or CANCELLED event; 503 storage unavailable.", tags: ["Events"], auth: "staff", successStatus: 200 },
  { method: "delete", path: "/v1/organizations/{organizationId}/events/{eventId}/cover", contract: event.removeEventCoverRequest, summary: "Remove the event's cover image (the event then has cover: null)", tags: ["Events"], auth: "staff", successStatus: 200 },

  // --- Ticket types -----------------------------------------------------------------------------
  { method: "post", path: "/v1/organizations/{organizationId}/events/{eventId}/ticket-types", contract: ticketType.createTicketTypeRequest, bodyComponent: "TicketTypeCreateRequest", summary: "Add a free ticket type (its limit must fit within the event's capacity)", tags: ["Ticket types"], auth: "staff", successStatus: 201 },
  { method: "get", path: "/v1/organizations/{organizationId}/events/{eventId}/ticket-types", contract: ticketType.listTicketTypesRequest, summary: "List an event's ticket types", tags: ["Ticket types"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}/events/{eventId}/ticket-types/{ticketTypeId}", contract: ticketType.updateTicketTypeRequest, bodyComponent: "TicketTypeUpdateRequest", summary: "Update a ticket type (PATCH semantics)", tags: ["Ticket types"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}/events/{eventId}/ticket-types/{ticketTypeId}/status", contract: ticketType.changeTicketTypeStatusRequest, bodyComponent: "StatusChangeRequest", summary: "Activate or deactivate a ticket type (a published event keeps at least one active)", tags: ["Ticket types"], auth: "staff", successStatus: 200 },

  // --- Guests (person: reusable attendee profiles) -------------------------------------------------
  { method: "post", path: "/v1/organizations/{organizationId}/persons", contract: person.createPersonRequest, bodyComponent: "PersonCreateRequest", summary: "Create a guest profile (only first_name is required; Ethiopian mobiles are stored as +251…)", tags: ["Guests"], auth: "staff", successStatus: 201 },
  { method: "get", path: "/v1/organizations/{organizationId}/persons", contract: person.listPersonsRequest, summary: "Search guest profiles (q matches names, email and phone)", tags: ["Guests"], auth: "staff", successStatus: 200 },
  { method: "get", path: "/v1/organizations/{organizationId}/persons/{personId}", contract: person.getPersonRequest, summary: "Read a guest profile with their registrations in this organization (to confirm a returning guest)", tags: ["Guests"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}/persons/{personId}", contract: person.updatePersonRequest, bodyComponent: "PersonUpdateRequest", summary: "Update a guest profile (PATCH semantics)", tags: ["Guests"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}/persons/{personId}/status", contract: person.changePersonStatusRequest, bodyComponent: "StatusChangeRequest", summary: "Activate or deactivate a guest profile (a deactivated guest can't be registered)", tags: ["Guests"], auth: "staff", successStatus: 200 },

  // --- Registrations (an event's guest list) --------------------------------------------------------
  { method: "post", path: "/v1/organizations/{organizationId}/events/{eventId}/registrations", contract: registration.createRegistrationRequest, bodyComponent: "RegistrationCreateRequest", summary: "Register a guest (person_id or a new person); 201 when a place was taken, 200 when already registered", description: "Same rules as the public form: a PUBLISHED event, not ended, inside its registration window, an active ticket type and a free place at both the event and the ticket type. Errors: 409 registration_closed (details.reason), 409 capacity_reached (details.scope), 409 already_registered, 409 ticket_type_inactive, 409 person_inactive, 400 ticket_type_required.", tags: ["Registrations"], auth: "staff", successStatus: 201 },
  { method: "get", path: "/v1/organizations/{organizationId}/events/{eventId}/registrations", contract: registration.listRegistrationsRequest, summary: "The event's guest list, newest first (q searches the guest's names, email and phone)", tags: ["Registrations"], auth: "staff", successStatus: 200 },
  { method: "get", path: "/v1/organizations/{organizationId}/events/{eventId}/registrations/summary", contract: registration.getRegistrationSummaryRequest, summary: "Places confirmed and left, for the event and each ticket type", tags: ["Registrations"], auth: "staff", successStatus: 200 },
  { method: "get", path: "/v1/organizations/{organizationId}/events/{eventId}/registrations/{registrationId}", contract: registration.getRegistrationRequest, summary: "Read a registration", tags: ["Registrations"], auth: "staff", successStatus: 200 },
  { method: "patch", path: "/v1/organizations/{organizationId}/events/{eventId}/registrations/{registrationId}/status", contract: registration.changeRegistrationStatusRequest, bodyComponent: "RegistrationStatusChangeRequest", summary: "Cancel a registration (frees the place) or reactivate it (every registration check again)", tags: ["Registrations"], auth: "staff", successStatus: 200 },

  // --- Public (no login) ------------------------------------------------------------------------
  { method: "get", path: "/v1/public/events", contract: publicEvent.listPublicEventsRequest, summary: "Public catalog: upcoming and live PUBLISHED + PUBLIC events of active organizations, by start time (filters: exact category, organization slug)", tags: ["Public"], auth: "public", successStatus: 200 },
  { method: "get", path: "/v1/public/organizations/{organizationSlug}/events/{eventSlug}", contract: publicEvent.getPublicEventRequest, summary: "Public event page by both slugs: any event published at least once (also UNLISTED, ended, closed or cancelled); 404 for drafts", tags: ["Public"], auth: "public", successStatus: 200 },
  { method: "post", path: "/v1/public/organizations/{organizationSlug}/events/{eventSlug}/registrations", contract: publicRegistration.createPublicRegistrationRequest, bodyComponent: "PublicRegistrationRequest", summary: "Register for an event without an account (Idempotency-Key required): 201 with the code; the same key and form again returns the same registration with 200", description: "Same rules as staff entry: the event must be taking registrations, the ticket type active and a place free. Errors: 400 validation_error (e.g. headers.idempotency-key, a non-Ethiopian mobile), 404 unknown event, 409 privacy_notice_outdated (details.current), 409 idempotency_key_reused, 409 registration_closed (details.reason), 409 capacity_reached (details.scope), 400 ticket_type_required, 429 rate_limited (10 a minute per IP).", tags: ["Public"], auth: "public", successStatus: 201 },
];

// ---------------------------------------------------------------------------------------------
// Document builder: Zod is the single source of truth; no prototype patching, no global registry.
// ---------------------------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;
type Parameter = { name: string; in: "path" | "query" | "header"; required: boolean; schema: JsonSchema };
type Operation = {
  summary: string;
  description?: string;
  tags: string[];
  security: Array<Record<string, string[]>>;
  parameters?: Parameter[];
  requestBody?: { required: boolean; content: Record<string, { schema: JsonSchema }> };
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

/** "idempotency-key" → "Idempotency-Key": header names are case-insensitive; this is how clients write them. */
const headerDisplayName = (name: string) => name.replace(/(^|-)([a-z])/g, (_match, dash: string, letter: string) => `${dash}${letter.toUpperCase()}`);

function parametersOf(location: "path" | "query" | "header", schema: z.ZodObject | undefined): Parameter[] {
  if (!schema) return [];
  const fields = Object.entries(schema.shape) as Array<[string, z.ZodType]>;
  return fields.map(([name, field]) => ({
    name: location === "header" ? headerDisplayName(name) : name,
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

    if (operation.fileUpload && contract.body) throw new Error(`${label}: a file upload cannot also have a JSON body`);

    let requestBody: Operation["requestBody"];
    if (operation.fileUpload) {
      const { field, description } = operation.fileUpload;
      requestBody = {
        required: true,
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              required: [field],
              properties: { [field]: { type: "string", format: "binary", description } },
              additionalProperties: false,
            },
          },
        },
      };
    }
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

    const parameters = [
      ...parametersOf("path", contract.params),
      ...parametersOf("query", contract.query),
      ...parametersOf("header", contract.headers),
    ];
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
