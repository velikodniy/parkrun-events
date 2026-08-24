import { assertEquals, assertRejects } from "@std/assert";
import type {
  HistoricalSnapshot,
  HistoricalSnapshotManifestEntry,
} from "../src/history_manifest.ts";
import {
  HistoricalSnapshotConflictError,
  HistoricalSnapshotLoader,
} from "../src/history_loader.ts";
import { KvArchive } from "../src/kv_archive.ts";
import { parseEventsDocument } from "../src/source.ts";
import { eventFeature, eventsDocument } from "./fixtures/events.ts";

function entry(date: string): HistoricalSnapshotManifestEntry {
  return {
    date,
    fetchedAt: `${date}T03:00:00.000Z`,
    file: `${date}.json`,
    sha256: date.replaceAll("-", "").padEnd(64, "0"),
    etag: null,
  };
}

function snapshot(
  date: string,
  features: readonly Record<string, unknown>[],
): HistoricalSnapshot {
  const metadata = entry(date);
  return {
    ...metadata,
    sourceSha256: metadata.sha256,
    events: parseEventsDocument(eventsDocument(features), {
      minimumEventCount: 1,
    }),
  };
}

function catalogue(
  renamedSlug: string | null = null,
): readonly Record<string, unknown>[] {
  return Array.from({ length: 20 }, (_, index) => {
    const id = index + 1;
    const slug = id === 1 && renamedSlug !== null ? renamedSlug : `event-${id}`;
    return eventFeature(id, slug);
  });
}

Deno.test("historical loader publishes chronological snapshots idempotently", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    const snapshots = new Map([
      ["2026-08-01", snapshot("2026-08-01", catalogue())],
      ["2026-08-02", snapshot("2026-08-02", catalogue("renamed-event"))],
    ]);
    const entries = [...snapshots.values()].map((value) => entry(value.date));
    const loader = new HistoricalSnapshotLoader(archive);
    const progress: string[] = [];
    const read = (metadata: HistoricalSnapshotManifestEntry) =>
      Promise.resolve(snapshots.get(metadata.date)!);

    const first = await loader.load(entries, read, {
      today: "2026-08-03",
      onProgress: (event) => progress.push(`${event.phase}:${event.date}`),
    });
    assertEquals(first.rows.map((row) => row.outcome.status), [
      "ACCEPTED",
      "ACCEPTED",
    ]);
    assertEquals(first.pendingDate, null);
    assertEquals(progress, [
      "SNAPSHOT_STARTED:2026-08-01",
      "SNAPSHOT_FINISHED:2026-08-01",
      "SNAPSHOT_STARTED:2026-08-02",
      "SNAPSHOT_FINISHED:2026-08-02",
    ]);

    const lookups = await archive.lookupMany([
      { slug: "event-1", asOf: "2026-08-01" },
      { slug: "renamed-event", asOf: "2026-08-02" },
      { slug: "event-1", asOf: "2026-08-02" },
    ]);
    assertEquals(lookups.map((result) => result.status), [
      "FOUND",
      "FOUND",
      "NOT_FOUND",
    ]);

    const second = await loader.load(entries, read, { today: "2026-08-03" });
    assertEquals(second.rows.map((row) => row.outcome.status), [
      "ALREADY_ACCEPTED",
      "ALREADY_ACCEPTED",
    ]);
  } finally {
    kv.close();
  }
});

Deno.test("historical loader rejects conflicting or noncontiguous backfill", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    const loader = new HistoricalSnapshotLoader(archive);
    const first = snapshot("2026-08-01", catalogue());
    const third = snapshot("2026-08-03", catalogue());
    const snapshots = new Map([
      [first.date, first],
      [third.date, third],
    ]);
    await loader.load(
      [entry(first.date), entry(third.date)],
      (metadata) => Promise.resolve(snapshots.get(metadata.date)!),
      { today: "2026-08-04" },
    );

    const conflicting = snapshot("2026-08-01", catalogue("wrong-history"));
    await assertRejects(
      () =>
        loader.load(
          [entry(conflicting.date)],
          () => Promise.resolve(conflicting),
          { today: "2026-08-04" },
        ),
      HistoricalSnapshotConflictError,
      "does not match",
    );

    const missingMiddle = snapshot("2026-08-02", catalogue());
    await assertRejects(
      () =>
        loader.load(
          [entry(missingMiddle.date)],
          () => Promise.resolve(missingMiddle),
          { today: "2026-08-04" },
        ),
      HistoricalSnapshotConflictError,
      "cannot insert",
    );
  } finally {
    kv.close();
  }
});

Deno.test("historical loader applies anomaly confirmation to snapshots", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    const loader = new HistoricalSnapshotLoader(archive);
    const snapshots = [
      snapshot("2026-08-01", catalogue()),
      snapshot(
        "2026-08-02",
        catalogue().map((feature, index) =>
          index < 3 ? eventFeature(index + 1, `changed-${index + 1}`) : feature
        ),
      ),
      snapshot(
        "2026-08-03",
        catalogue().map((feature, index) =>
          index < 3 ? eventFeature(index + 1, `changed-${index + 1}`) : feature
        ),
      ),
    ];
    const byDate = new Map(snapshots.map((value) => [value.date, value]));

    const firstRun = await loader.load(
      snapshots.slice(0, 2).map((value) => entry(value.date)),
      (metadata) => Promise.resolve(byDate.get(metadata.date)!),
      { today: "2026-08-04" },
    );
    assertEquals(firstRun.rows.map((row) => row.outcome.status), [
      "ACCEPTED",
      "PENDING_CONFIRMATION",
    ]);
    assertEquals(firstRun.pendingDate, "2026-08-02");

    const resumed = await loader.load(
      snapshots.slice(1).map((value) => entry(value.date)),
      (metadata) => Promise.resolve(byDate.get(metadata.date)!),
      { today: "2026-08-04" },
    );
    assertEquals(resumed.rows.map((row) => row.outcome.status), [
      "PENDING_CONFIRMATION",
      "ACCEPTED",
    ]);
    assertEquals(
      resumed.rows[1]?.outcome.status === "ACCEPTED" &&
        resumed.rows[1].outcome.confirmedAnomaly,
      true,
    );
    assertEquals(resumed.pendingDate, null);
  } finally {
    kv.close();
  }
});
