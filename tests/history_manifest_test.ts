import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  HistoricalSnapshotError,
  parseHistoricalSnapshotManifest,
  readHistoricalSnapshot,
  readHistoricalSnapshotManifest,
} from "../src/history_manifest.ts";
import { sha256Hex } from "../src/model.ts";
import { eventFeature, eventsDocument } from "./fixtures/events.ts";

function manifestEntry(
  date: string,
  file = `${date}.json`,
): Record<string, unknown> {
  return {
    date,
    fetchedAt: `${date}T03:00:00.000Z`,
    file,
    sha256: "a".repeat(64),
    etag: null,
  };
}

function manifest(
  snapshots: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return {
    formatVersion: 1,
    sourceUrl: "https://images.parkrun.com/events.json",
    snapshots,
  };
}

Deno.test("snapshot manifests require strictly chronological observations", () => {
  const parsed = parseHistoricalSnapshotManifest(manifest([
    manifestEntry("2026-08-01"),
    manifestEntry("2026-08-02"),
  ]));

  assertEquals(parsed.snapshots.map((snapshot) => snapshot.date), [
    "2026-08-01",
    "2026-08-02",
  ]);
  assertEquals(parsed.snapshots[0]?.fetchedAt, "2026-08-01T03:00:00.000Z");

  assertThrows(
    () =>
      parseHistoricalSnapshotManifest(manifest([
        manifestEntry("2026-08-02"),
        manifestEntry("2026-08-01"),
      ])),
    HistoricalSnapshotError,
    "strictly increasing",
  );
});

Deno.test("snapshot manifests reject unsafe file paths and unknown fields", () => {
  assertThrows(
    () =>
      parseHistoricalSnapshotManifest(manifest([
        manifestEntry("2026-08-01", "../outside.json"),
      ])),
    HistoricalSnapshotError,
    "relative file",
  );

  assertThrows(
    () =>
      parseHistoricalSnapshotManifest({
        ...manifest([manifestEntry("2026-08-01")]),
        typo: true,
      }),
    HistoricalSnapshotError,
    "unknown field",
  );
});

Deno.test("snapshot manifests bound input size", async () => {
  await assertRejects(
    () =>
      readHistoricalSnapshotManifest(
        "manifest.json",
        () => Promise.resolve(" ".repeat(1_100_000)),
      ),
    HistoricalSnapshotError,
    "too large",
  );
});

Deno.test("snapshot files are hash-checked and source-validated", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(eventsDocument([
    eventFeature(1, "one"),
  ])));
  const hash = await sha256Hex(bytes);
  const parsed = parseHistoricalSnapshotManifest(manifest([{
    ...manifestEntry("2026-08-01"),
    sha256: hash,
  }]));
  let requestedPath = "";

  const snapshot = await readHistoricalSnapshot(
    "history/manifest.json",
    parsed.snapshots[0]!,
    {
      minimumEventCount: 1,
      readFile: (path) => {
        requestedPath = path;
        return Promise.resolve(bytes);
      },
      realPath: (path) => Promise.resolve(path),
    },
  );

  assertEquals(requestedPath.endsWith("/history/2026-08-01.json"), true);
  assertEquals(snapshot.events.map((event) => event.slug), ["one"]);
  assertEquals(snapshot.sourceSha256, hash);

  await assertRejects(
    () =>
      readHistoricalSnapshot(
        "history/manifest.json",
        { ...parsed.snapshots[0]!, sha256: "b".repeat(64) },
        {
          minimumEventCount: 1,
          readFile: () => Promise.resolve(bytes),
          realPath: (path) => Promise.resolve(path),
        },
      ),
    HistoricalSnapshotError,
    "hash",
  );

  await assertRejects(
    () =>
      readHistoricalSnapshot(
        "history/manifest.json",
        parsed.snapshots[0]!,
        {
          minimumEventCount: 1,
          readFile: () => Promise.resolve(bytes),
          realPath: (path) =>
            Promise.resolve(
              path.endsWith("/history") ? path : "/outside/snapshot.json",
            ),
        },
      ),
    HistoricalSnapshotError,
    "outside",
  );
});
