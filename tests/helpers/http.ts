import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";

export type TestResponse = { status: number; body: any; headers: Headers };

/** Mounts the real app on an ephemeral port for the duration of `run`. */
export async function withServer<T>(app: Express, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export async function call(
  baseUrl: string,
  method: string,
  path: string,
  options: { token?: string; body?: unknown; rawBody?: string } = {},
): Promise<TestResponse> {
  const hasBody = options.body !== undefined || options.rawBody !== undefined;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
    },
    body: options.rawBody ?? (options.body === undefined ? null : JSON.stringify(options.body)),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}
