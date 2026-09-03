import { assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { KvArchive } from "../src/kv_archive.ts";

Deno.test("health endpoint reports an empty but available archive", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const app = createApp(new KvArchive(kv));
    const response = await app(new Request("http://localhost/health"));

    assertEquals(response.status, 200);
    assertEquals(response.headers.get("access-control-allow-origin"), "*");
    assertEquals(await response.json(), {
      status: "ok",
      latestObservation: null,
    });
  } finally {
    kv.close();
  }
});

Deno.test("GraphQL endpoint serves GraphiQL", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const app = createApp(new KvArchive(kv));
    const response = await app(
      new Request("http://localhost/graphql", {
        headers: { accept: "text/html" },
      }),
    );

    assertEquals(response.status, 200);
    const html = await response.text();
    assertStringIncludes(html, "parkrun events archive");
    assertStringIncludes(html, "defaultTabs");
    assertStringIncludes(html, "ArchiveOverview");
  } finally {
    kv.close();
  }
});

Deno.test("HTTP handler rejects an oversized GraphQL request", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const app = createApp(new KvArchive(kv), { maximumRequestBytes: 32 });
    const response = await app(
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: `{ ${"x".repeat(100)} }` }),
      }),
    );

    assertEquals(response.status, 413);
    assertEquals(await response.json(), {
      errors: [{
        message: "GraphQL request body is too large",
        extensions: { code: "REQUEST_TOO_LARGE" },
      }],
    });
  } finally {
    kv.close();
  }
});
