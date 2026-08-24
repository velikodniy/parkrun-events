import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  applyHistoricalSnapshotsToDatabase,
  parseHistoricalLoaderArgs,
  runHistoricalLoader,
  validateProductionDatabaseUrl,
} from "../src/history_cli.ts";
import type {
  HistoricalSnapshot,
  HistoricalSnapshotManifest,
  HistoricalSnapshotManifestEntry,
} from "../src/history_manifest.ts";
import { HistoricalSnapshotError } from "../src/history_manifest.ts";
import { parseEventsDocument } from "../src/source.ts";
import { eventFeature, eventsDocument } from "./fixtures/events.ts";

function snapshotEntry(date: string): HistoricalSnapshotManifestEntry {
  return {
    date,
    fetchedAt: `${date}T03:00:00.000Z`,
    file: `${date}.json`,
    sha256: date.replaceAll("-", "").padEnd(64, "0"),
    etag: null,
  };
}

function snapshotManifest(
  dates: readonly string[],
): HistoricalSnapshotManifest {
  return {
    formatVersion: 1,
    sourceUrl: "https://images.parkrun.com/events.json",
    snapshots: dates.map(snapshotEntry),
  };
}

function historicalSnapshot(
  entry: HistoricalSnapshotManifestEntry,
): HistoricalSnapshot {
  return {
    ...entry,
    sourceSha256: entry.sha256,
    events: parseEventsDocument(
      eventsDocument([
        eventFeature(1, `event-${entry.date}`),
      ]),
      { minimumEventCount: 1 },
    ),
  };
}

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
      acceptPending: false,
      help: false,
    },
  );
  assertEquals(
    parseHistoricalLoaderArgs([
      "--manifest=snapshots/manifest.json",
      "--database-url",
      "https://api.deno.com/v2/databases/123/connect",
      "--apply",
      "--accept-pending",
    ]),
    {
      manifestPath: "snapshots/manifest.json",
      databaseUrl: "https://api.deno.com/v2/databases/123/connect",
      apply: true,
      acceptPending: true,
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
        "--accept-pending",
      ]),
    TypeError,
    "requires --apply",
  );
});

Deno.test("historical loader validates every file before applying", async () => {
  const manifest = snapshotManifest(["2026-08-01", "2026-08-02"]);
  const order: string[] = [];
  const arguments_ = parseHistoricalLoaderArgs([
    "--manifest",
    "manifest.json",
    "--apply",
  ]);

  await runHistoricalLoader(arguments_, {
    today: "2026-08-03",
    env: (name) =>
      name === "DENO_KV_ACCESS_TOKEN"
        ? "available"
        : "https://api.deno.com/v2/databases/id/connect",
    readManifest: () => Promise.resolve(manifest),
    readSnapshot: (_path, entry) => {
      order.push(`validate:${entry.date}`);
      return Promise.resolve(historicalSnapshot(entry));
    },
    applySnapshots: async (_url, entries, readSnapshot) => {
      order.push("apply");
      for (const entry of entries) await readSnapshot(entry);
      return { rows: [], pendingDate: null };
    },
    writeLine: () => {},
  });

  assertEquals(order, [
    "validate:2026-08-01",
    "validate:2026-08-02",
    "apply",
    "validate:2026-08-01",
    "validate:2026-08-02",
  ]);
});

Deno.test("historical loader never opens production after validation fails", async () => {
  const manifest = snapshotManifest(["2026-08-01", "2026-08-02"]);
  let applied = false;
  await assertRejects(
    () =>
      runHistoricalLoader(
        parseHistoricalLoaderArgs([
          "--manifest",
          "manifest.json",
          "--apply",
        ]),
        {
          today: "2026-08-03",
          env: () => "available",
          readManifest: () => Promise.resolve(manifest),
          readSnapshot: (_path, entry) =>
            entry.date === "2026-08-02"
              ? Promise.reject(new HistoricalSnapshotError("bad snapshot"))
              : Promise.resolve(historicalSnapshot(entry)),
          applySnapshots: () => {
            applied = true;
            return Promise.resolve({ rows: [], pendingDate: null });
          },
          writeLine: () => {},
        },
      ),
    HistoricalSnapshotError,
    "bad snapshot",
  );
  assertEquals(applied, false);
});

Deno.test("historical loader requires an environment token before apply", async () => {
  const manifest = snapshotManifest(["2026-08-01"]);
  let applied = false;
  await assertRejects(
    () =>
      runHistoricalLoader(
        parseHistoricalLoaderArgs([
          "--manifest",
          "manifest.json",
          "--apply",
        ]),
        {
          today: "2026-08-02",
          env: () => undefined,
          readManifest: () => Promise.resolve(manifest),
          readSnapshot: (_path, entry) =>
            Promise.resolve(historicalSnapshot(entry)),
          applySnapshots: () => {
            applied = true;
            return Promise.resolve({ rows: [], pendingDate: null });
          },
          writeLine: () => {},
        },
      ),
    TypeError,
    "DENO_KV_ACCESS_TOKEN",
  );
  assertEquals(applied, false);
});

Deno.test("production snapshot apply closes its KV connection", async () => {
  const entry = snapshotEntry("2026-08-01");
  const kv = await Deno.openKv(":memory:");
  const report = await applyHistoricalSnapshotsToDatabase(
    "unused-by-injected-opener",
    [entry],
    () => Promise.resolve(historicalSnapshot(entry)),
    "2026-08-02",
    () => Promise.resolve(kv),
  );
  assertEquals(report.rows[0]?.outcome.status, "ACCEPTED");
  await assertRejects(
    () => kv.get(["closed"]),
    Error,
  );
});

Deno.test("historical loader reports trailing pending state explicitly", async () => {
  const manifest = snapshotManifest(["2026-08-01"]);
  const baseOptions = {
    today: "2026-08-02",
    env: (name: string) =>
      name === "DENO_KV_ACCESS_TOKEN"
        ? "available"
        : "https://api.deno.com/v2/databases/id/connect",
    readManifest: () => Promise.resolve(manifest),
    readSnapshot: (_path: string, entry: HistoricalSnapshotManifestEntry) =>
      Promise.resolve(historicalSnapshot(entry)),
    applySnapshots: () =>
      Promise.resolve({ rows: [], pendingDate: "2026-08-01" }),
    writeLine: () => {},
  };
  await assertRejects(
    () =>
      runHistoricalLoader(
        parseHistoricalLoaderArgs([
          "--manifest",
          "manifest.json",
          "--apply",
        ]),
        baseOptions,
      ),
    Error,
    "remains safely quarantined",
  );
  const accepted = await runHistoricalLoader(
    parseHistoricalLoaderArgs([
      "--manifest",
      "manifest.json",
      "--apply",
      "--accept-pending",
    ]),
    baseOptions,
  );
  assertEquals(accepted?.pendingDate, "2026-08-01");
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
