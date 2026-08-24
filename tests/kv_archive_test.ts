import { assert, assertEquals, assertRejects } from "@std/assert";
import { ArchiveCorruptError, KvArchive } from "../src/kv_archive.ts";
import { buildRevision, diffRevisions } from "../src/model.ts";
import type {
  BucketEntry,
  CatalogueRevision,
  EventRecord,
} from "../src/model.ts";

function event(id: number, slug: string): EventRecord {
  return {
    id,
    slug,
    name: `${slug} parkrun`,
    shortName: slug,
    localisedName: null,
    location: `${slug} park`,
    latitude: 51,
    longitude: -1,
    countryCode: 97,
    countryUrl: "https://www.parkrun.org.uk",
    seriesId: 1,
  };
}

Deno.test("KvArchive publishes a baseline and resolves as-of fallback", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    const revision = await buildRevision([event(1, "alpha")]);
    await archive.stageRevision(revision);
    const control = await archive.readControl("2026-08-02");
    assert(
      await archive.commitObservation(control, {
        date: "2026-08-02",
        fetchedAt: "2026-08-02T03:00:00.000Z",
        revisionHash: revision.hash,
        eventCount: 1,
        sourceEtag: "etag-1",
        changeSetHash: null,
        confirmedAnomaly: false,
      }),
    );

    assertEquals(
      await archive.lookupMany([
        { slug: "alpha", asOf: "2026-08-01" },
        { slug: "alpha", asOf: "2026-08-02" },
        { slug: "alpha", asOf: "2026-08-03" },
        { slug: "missing", asOf: "2026-08-03" },
        { slug: "alpha", asOf: "9999-12-31" },
      ]),
      [
        {
          status: "NO_ARCHIVE_COVERAGE",
          requestedSlug: "alpha",
          requestedDate: "2026-08-01",
          observation: null,
          event: null,
        },
        {
          status: "FOUND",
          requestedSlug: "alpha",
          requestedDate: "2026-08-02",
          observation: {
            date: "2026-08-02",
            fetchedAt: "2026-08-02T03:00:00.000Z",
          },
          event: event(1, "alpha"),
        },
        {
          status: "FOUND",
          requestedSlug: "alpha",
          requestedDate: "2026-08-03",
          observation: {
            date: "2026-08-02",
            fetchedAt: "2026-08-02T03:00:00.000Z",
          },
          event: event(1, "alpha"),
        },
        {
          status: "NOT_FOUND",
          requestedSlug: "missing",
          requestedDate: "2026-08-03",
          observation: {
            date: "2026-08-02",
            fetchedAt: "2026-08-02T03:00:00.000Z",
          },
          event: null,
        },
        {
          status: "FOUND",
          requestedSlug: "alpha",
          requestedDate: "9999-12-31",
          observation: {
            date: "2026-08-02",
            fetchedAt: "2026-08-02T03:00:00.000Z",
          },
          event: event(1, "alpha"),
        },
      ],
    );
  } finally {
    kv.close();
  }
});

Deno.test("KvArchive rejects an observation whose value date differs from its key", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    const revision = await buildRevision([event(1, "one")]);
    await archive.stageRevision(revision);
    const control = await archive.readControl("2026-08-01");
    assert(
      await archive.commitObservation(control, {
        date: "2026-08-01",
        fetchedAt: "2026-08-01T03:00:00.000Z",
        revisionHash: revision.hash,
        eventCount: 1,
        sourceEtag: null,
        changeSetHash: null,
        confirmedAnomaly: false,
      }),
    );
    const key: Deno.KvKey = [
      "parkrun-events",
      "v1",
      "observation",
      "2026-08-01",
    ];
    const stored = await kv.get<Record<string, unknown>>(key);
    await kv.set(key, { ...stored.value, date: "2026-08-31" });

    await assertRejects(
      () => archive.lookupMany([{ slug: "one", asOf: "2026-08-01" }]),
      ArchiveCorruptError,
      "does not match its key",
    );
  } finally {
    kv.close();
  }
});

Deno.test("KvArchive rejects a head that disagrees with its observation", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    const revision = await buildRevision([event(1, "one")]);
    await archive.stageRevision(revision);
    const control = await archive.readControl("2026-08-01");
    assert(
      await archive.commitObservation(control, {
        date: "2026-08-01",
        fetchedAt: "2026-08-01T03:00:00.000Z",
        revisionHash: revision.hash,
        eventCount: 1,
        sourceEtag: null,
        changeSetHash: null,
        confirmedAnomaly: false,
      }),
    );
    const key: Deno.KvKey = ["parkrun-events", "v1", "meta", "head"];
    const stored = await kv.get<Record<string, unknown>>(key);
    await kv.set(key, { ...stored.value, eventCount: 2 });

    await assertRejects(
      () => archive.getArchiveInfo(),
      ArchiveCorruptError,
      "does not match",
    );
  } finally {
    kv.close();
  }
});

Deno.test("KvArchive keeps staged revisions invisible until publication", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    await archive.stageRevision(await buildRevision([event(1, "staged")]));

    assertEquals(
      await archive.lookupMany([
        { slug: "staged", asOf: "2026-08-01" },
      ]),
      [{
        status: "NO_ARCHIVE_COVERAGE",
        requestedSlug: "staged",
        requestedDate: "2026-08-01",
        observation: null,
        event: null,
      }],
    );
  } finally {
    kv.close();
  }
});

Deno.test("KvArchive sizes the actual stored bucket representation", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    const base = await buildRevision([event(1, "base")]);
    const entries: BucketEntry[] = Array.from(
      { length: 500 },
      (_, index) => ({
        slug: `event-${index + 1}`,
        id: index + 1,
        eventHash: "a".repeat(64),
      }),
    );
    const oversized: CatalogueRevision = {
      ...base,
      bucketHashes: ["oversized"],
      buckets: [{ index: 0, hash: "oversized", entries }],
      manifest: { ...base.manifest, bucketHashes: ["oversized"] },
    };

    await assertRejects(
      () => archive.stageRevision(oversized),
      RangeError,
      "maximum safe size",
    );
  } finally {
    kv.close();
  }
});

Deno.test("KvArchive rejects oversized control values before publication", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    const revision = await buildRevision([event(1, "one")]);
    await archive.stageRevision(revision);
    const control = await archive.readControl("2026-08-01");

    await assertRejects(
      () =>
        archive.commitObservation(control, {
          date: "2026-08-01",
          fetchedAt: "2026-08-01T03:00:00.000Z",
          revisionHash: revision.hash,
          eventCount: 1,
          sourceEtag: "x".repeat(50_000),
          changeSetHash: null,
          confirmedAnomaly: false,
        }),
      ArchiveCorruptError,
      "ETag",
    );
    assertEquals((await archive.getArchiveInfo()).latestObservation, null);
  } finally {
    kv.close();
  }
});

Deno.test("KvArchive resolves an ordered 100-item batch", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    const events = Array.from(
      { length: 100 },
      (_, index) => event(index + 1, `event-${index + 1}`),
    );
    const revision = await buildRevision(events);
    await archive.stageRevision(revision);
    const control = await archive.readControl("2026-08-01");
    assert(
      await archive.commitObservation(control, {
        date: "2026-08-01",
        fetchedAt: "2026-08-01T03:00:00.000Z",
        revisionHash: revision.hash,
        eventCount: events.length,
        sourceEtag: null,
        changeSetHash: null,
        confirmedAnomaly: false,
      }),
    );

    const inputs = [...events].reverse().map((item) => ({
      slug: item.slug,
      asOf: "2026-08-01",
    }));
    const results = await archive.lookupMany(inputs);
    assertEquals(
      results.map((result) => result.event?.id),
      Array.from({ length: 100 }, (_, index) => 100 - index),
    );
  } finally {
    kv.close();
  }
});

Deno.test("KvArchive keeps renamed slugs historical and preserves batch order", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    const before = await buildRevision([event(1, "old-slug")]);
    const after = await buildRevision([event(1, "new-slug")]);
    await archive.stageRevision(before);
    let control = await archive.readControl("2026-08-01");
    assert(
      await archive.commitObservation(control, {
        date: "2026-08-01",
        fetchedAt: "2026-08-01T03:00:00.000Z",
        revisionHash: before.hash,
        eventCount: 1,
        sourceEtag: null,
        changeSetHash: null,
        confirmedAnomaly: false,
      }),
    );

    await archive.stageRevision(after);
    const changeSetHash = await archive.stageChangeSet(
      before.hash,
      after.hash,
      diffRevisions(before, after),
    );
    control = await archive.readControl("2026-08-02");
    assert(
      await archive.commitObservation(control, {
        date: "2026-08-02",
        fetchedAt: "2026-08-02T03:00:00.000Z",
        revisionHash: after.hash,
        eventCount: 1,
        sourceEtag: null,
        changeSetHash,
        confirmedAnomaly: false,
      }),
    );

    const changes = await archive.listCatalogueChanges({
      from: "2026-08-01",
      through: "9999-12-31",
      first: 10,
    });
    assertEquals(changes.nodes, [{
      hash: changeSetHash,
      observation: {
        date: "2026-08-02",
        fetchedAt: "2026-08-02T03:00:00.000Z",
      },
      previousObservation: {
        date: "2026-08-01",
        fetchedAt: "2026-08-01T03:00:00.000Z",
      },
      counts: { appeared: 0, disappeared: 0, updated: 1 },
      confirmedAnomaly: false,
    }]);
    assertEquals(changes.hasNextPage, false);
    assertEquals(
      await archive.getEventChanges(changeSetHash, "updated", { first: 10 }),
      {
        nodes: [{
          id: 1,
          before: event(1, "old-slug"),
          after: event(1, "new-slug"),
          changedFields: ["SLUG", "NAME", "SHORT_NAME", "LOCATION"],
        }],
        endId: 1,
        hasNextPage: false,
      },
    );

    const results = await archive.lookupMany([
      { slug: "new-slug", asOf: "2026-08-02" },
      { slug: "old-slug", asOf: "2026-08-01" },
      { slug: "old-slug", asOf: "2026-08-02" },
      { slug: "new-slug", asOf: "2026-08-02" },
    ]);
    assertEquals(results.map((result) => [result.status, result.event?.id]), [
      ["FOUND", 1],
      ["FOUND", 1],
      ["NOT_FOUND", undefined],
      ["FOUND", 1],
    ]);

    const manifestKey: Deno.KvKey = [
      "parkrun-events",
      "v1",
      "change-set",
      changeSetHash,
    ];
    const manifest = await kv.get<Record<string, unknown>>(manifestKey);
    await kv.set(manifestKey, {
      ...manifest.value,
      pageCounts: { appeared: 0, disappeared: 0, updated: 100_000_000 },
    });
    await assertRejects(
      () => archive.listCatalogueChanges({ first: 10 }),
      ArchiveCorruptError,
      "page count",
    );
  } finally {
    kv.close();
  }
});

Deno.test("KvArchive protects a newer pending candidate from older work", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    const revision = await buildRevision([event(1, "one")]);
    const candidate = await buildRevision([event(2, "two")]);
    await archive.stageRevision(revision);
    await archive.stageRevision(candidate);
    const changeSetHash = await archive.stageChangeSet(
      revision.hash,
      candidate.hash,
      diffRevisions(revision, candidate),
    );
    let control = await archive.readControl("2026-08-01");
    assert(
      await archive.commitObservation(control, {
        date: "2026-08-01",
        fetchedAt: "2026-08-01T03:00:00.000Z",
        revisionHash: revision.hash,
        eventCount: 1,
        sourceEtag: null,
        changeSetHash: null,
        confirmedAnomaly: false,
      }),
    );

    control = await archive.readControl("2026-08-03");
    assert(
      await archive.commitPending(control, {
        firstSeenDate: "2026-08-03",
        baseRevisionHash: revision.hash,
        candidateRevisionHash: candidate.hash,
        changeSetHash,
        eventCount: 1,
      }),
    );
    const older = await archive.readControl("2026-08-02");
    await assertRejects(
      () =>
        archive.commitObservation(older, {
          date: "2026-08-02",
          fetchedAt: "2026-08-02T03:00:00.000Z",
          revisionHash: revision.hash,
          eventCount: 1,
          sourceEtag: null,
          changeSetHash: null,
          confirmedAnomaly: false,
        }),
      RangeError,
      "pending candidate",
    );
    await assertRejects(
      () =>
        archive.commitPending(older, {
          firstSeenDate: "2026-08-02",
          baseRevisionHash: revision.hash,
          candidateRevisionHash: candidate.hash,
          changeSetHash,
          eventCount: 1,
        }),
      RangeError,
      "pending candidate",
    );
  } finally {
    kv.close();
  }
});

Deno.test("KvArchive rejects an older publication after a newer winner", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    const first = await buildRevision([event(1, "first")]);
    const second = await buildRevision([event(2, "second")]);
    await archive.stageRevision(first);
    await archive.stageRevision(second);
    const stale = await archive.readControl("2026-08-01");
    const winner = await archive.readControl("2026-08-02");

    assert(
      await archive.commitObservation(winner, {
        date: "2026-08-02",
        fetchedAt: "2026-08-02T03:00:00.000Z",
        revisionHash: first.hash,
        eventCount: 1,
        sourceEtag: null,
        changeSetHash: null,
        confirmedAnomaly: false,
      }),
    );
    assertEquals(
      await archive.commitObservation(stale, {
        date: "2026-08-01",
        fetchedAt: "2026-08-01T03:01:00.000Z",
        revisionHash: second.hash,
        eventCount: 1,
        sourceEtag: null,
        changeSetHash: null,
        confirmedAnomaly: false,
      }),
      false,
    );
    assertEquals(
      (await archive.getArchiveInfo()).latestObservation?.date,
      "2026-08-02",
    );
  } finally {
    kv.close();
  }
});
