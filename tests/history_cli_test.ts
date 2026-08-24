import { assertEquals, assertThrows } from "@std/assert";
import {
  parseHistoricalLoaderArgs,
  validateProductionDatabaseUrl,
} from "../src/history_cli.ts";

Deno.test("historical loader CLI requires explicit apply mode", () => {
  assertEquals(
    parseHistoricalLoaderArgs([
      "--manifest",
      "snapshots/manifest.json",
    ]),
    {
      manifestPath: "snapshots/manifest.json",
      databaseUrl: null,
      apply: false,
      allowPending: false,
      help: false,
    },
  );
  assertEquals(
    parseHistoricalLoaderArgs([
      "--manifest=snapshots/manifest.json",
      "--database-url",
      "https://api.deno.com/v2/databases/123/connect",
      "--apply",
      "--allow-pending",
    ]),
    {
      manifestPath: "snapshots/manifest.json",
      databaseUrl: "https://api.deno.com/v2/databases/123/connect",
      apply: true,
      allowPending: true,
      help: false,
    },
  );
});

Deno.test("historical loader CLI rejects unsafe or secret-bearing arguments", () => {
  assertThrows(
    () => parseHistoricalLoaderArgs(["--apply"]),
    TypeError,
    "--manifest",
  );
  assertThrows(
    () =>
      parseHistoricalLoaderArgs([
        "--manifest",
        "manifest.json",
        "--token",
        "secret",
      ]),
    TypeError,
    "Unknown argument",
  );
  assertThrows(
    () =>
      parseHistoricalLoaderArgs([
        "--manifest",
        "manifest.json",
        "--allow-pending",
      ]),
    TypeError,
    "requires --apply",
  );
});

Deno.test("historical loader accepts only Deno production KV connector URLs", () => {
  assertEquals(
    validateProductionDatabaseUrl(
      "https://api.deno.com/v2/databases/018f-id/connect",
    ),
    "https://api.deno.com/v2/databases/018f-id/connect",
  );
  for (
    const value of [
      "http://api.deno.com/v2/databases/id/connect",
      "https://example.com/v2/databases/id/connect",
      "https://api.deno.com/v2/databases/id/connect?token=secret",
      "https://api.deno.com/v2/databases/id/other",
    ]
  ) {
    assertThrows(
      () => validateProductionDatabaseUrl(value),
      TypeError,
      "production Deno KV connector",
    );
  }
});
