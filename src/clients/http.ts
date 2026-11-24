/**
 * Transport-only helper shared by every outbound client: timeout, JSON parsing,
 * network failure classification. Each client maps status codes to its own AppErrors.
 */
export type UpstreamFailureKind = "timeout" | "network" | "non_json";

export class UpstreamRequestError extends Error {
  readonly upstream: string;
  readonly kind: UpstreamFailureKind;

  constructor(upstream: string, kind: UpstreamFailureKind, options?: { cause?: unknown }) {
    super(`${upstream} request failed (${kind})`, options);
    this.name = "UpstreamRequestError";
    this.upstream = upstream;
    this.kind = kind;
  }
}

export type JsonResponse = { status: number; ok: boolean; body: unknown };

export async function requestJson(
  url: URL,
  init: {
    upstream: string;
    timeoutMs: number;
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    headers?: Record<string, string>;
    body?: unknown;
  },
): Promise<JsonResponse> {
  let text: string;
  let status: number;
  let ok: boolean;

  try {
    const response = await fetch(url, {
      method: init.method ?? "GET",
      headers: {
        Accept: "application/json",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...init.headers,
      },
      body: init.body === undefined ? null : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs),
    });
    status = response.status;
    ok = response.ok;
    text = await response.text();
  } catch (error) {
    const kind = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network";
    throw new UpstreamRequestError(init.upstream, kind, { cause: error });
  }

  if (!text) return { status, ok, body: null };
  try {
    return { status, ok, body: JSON.parse(text) as unknown };
  } catch (error) {
    throw new UpstreamRequestError(init.upstream, "non_json", { cause: error });
  }
}
