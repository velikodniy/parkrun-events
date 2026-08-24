import type { ChangeFeed } from "./change_feed.ts";
import type { ChangeReadModel } from "./change_views.ts";
import { KvArchive } from "./kv_archive.ts";
import { createGraphqlServer } from "./graphql.ts";

const DEFAULT_MAXIMUM_REQUEST_BYTES = 64 * 1024;

export interface AppOptions {
  readonly maximumRequestBytes?: number;
  readonly changeViews?: ChangeReadModel;
  readonly changeFeed?: ChangeFeed;
}

export type HttpHandler = (request: Request) => Promise<Response>;

export function createApp(
  archive: KvArchive,
  options: AppOptions = {},
): HttpHandler {
  const graphql = createGraphqlServer(
    archive,
    options.changeViews,
    options.changeFeed,
  );
  const maximumRequestBytes = options.maximumRequestBytes ??
    DEFAULT_MAXIMUM_REQUEST_BYTES;

  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return Response.redirect(new URL("/graphql", url), 307);
    }
    if (url.pathname === "/health") {
      try {
        const info = await archive.getArchiveInfo();
        return jsonResponse({
          status: "ok",
          latestObservation: info.latestObservation?.date ?? null,
        });
      } catch {
        return jsonResponse({ status: "error", latestObservation: null }, 503);
      }
    }
    if (url.pathname !== "/graphql") {
      return jsonResponse({ error: "Not found" }, 404);
    }

    const boundedRequest = await readBoundedRequest(
      request,
      maximumRequestBytes,
    );
    if (boundedRequest === null) {
      return jsonResponse({
        errors: [{
          message: "GraphQL request body is too large",
          extensions: { code: "REQUEST_TOO_LARGE" },
        }],
      }, 413);
    }
    return await graphql.fetch(boundedRequest);
  };
}

async function readBoundedRequest(
  request: Request,
  maximumBytes: number,
): Promise<Request | null> {
  if (
    request.body === null || request.method === "GET" ||
    request.method === "HEAD"
  ) {
    return request;
  }
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null && Number.isFinite(Number(declaredLength)) &&
    Number(declaredLength) > maximumBytes
  ) {
    return null;
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("request body exceeds configured limit");
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    redirect: request.redirect,
    signal: request.signal,
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
  });
}
