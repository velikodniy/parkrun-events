import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import { ArchiveCorruptError, KvArchive } from "../src/kv_archive.ts";
import { buildRevision, diffRevisions } from "../src/model.ts";
import type {
  BucketEntry,
  CatalogueRevision,
  EventRecord,
} from "../src/model.ts";

function event(id: number, slug: string, countryCode = 97): EventRecord {
  return {
    id,
    slug,
    name: `${slug} parkrun`,
    shortName: slug,
    localisedName: null,
    location: `${slug} park`,
    latitude: 51,
    longitude: -1,
    countryCode,
    countryUrl: countryCode === 97
      ? "https://www.parkrun.org.uk"
      : `https://www.parkrun.example/${countryCode}`,
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
        { slug: "alpha", asOf: "2026-08-01", fallbackToEarliest: false },
        { slug: "alpha", asOf: "2026-08-02" },
        { slug: "alpha", asOf: "2026-08-03" },
        { slug: "missing", asOf: "2026-08-03" },
        { slug: "alpha", asOf: "9999-12-31" },
      ]),
      [
        {
          status: "NO_ARCHIVE_COVERAGE",
          requestedId: null,
          requestedSlug: "alpha",
          requestedDate: "2026-08-01",
          observation: null,
          event: null,
        },
        {
          status: "FOUND",
          requestedId: null,
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
          requestedId: null,
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
          requestedId: null,
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
          requestedId: null,
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
        requestedId: null,
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

Deno.test("KvArchive supports lookup by id across historical dates, renames, and disappearances", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    const day1Revision = await buildRevision([
      event(1, "bushy"),
      event(2, "richmond"),
    ]);
    await archive.stageRevision(day1Revision);
    let control = await archive.readControl("2026-01-06");
    assert(
      await archive.commitObservation(control, {
        date: "2026-01-06",
        fetchedAt: "2026-01-06T03:00:00.000Z",
        revisionHash: day1Revision.hash,
        eventCount: 2,
        sourceEtag: null,
        changeSetHash: null,
        confirmedAnomaly: false,
      }),
    );

    const day2Revision = await buildRevision([
      event(1, "bushy-park"),
      event(3, "wimbledon"),
    ]);
    await archive.stageRevision(day2Revision);
    const changeSetHash = await archive.stageChangeSet(
      day1Revision.hash,
      day2Revision.hash,
      diffRevisions(day1Revision, day2Revision),
    );
    control = await archive.readControl("2026-01-07");
    assert(
      await archive.commitObservation(control, {
        date: "2026-01-07",
        fetchedAt: "2026-01-07T03:00:00.000Z",
        revisionHash: day2Revision.hash,
        eventCount: 2,
        sourceEtag: null,
        changeSetHash,
        confirmedAnomaly: false,
      }),
    );

    const results = await archive.lookupMany([
      { id: 1, asOf: "2026-01-06" },
      { id: 1, asOf: "2026-01-07" },
      { id: 2, asOf: "2026-01-06" },
      { id: 2, asOf: "2026-01-07" },
      { id: 3, asOf: "2026-01-06" },
      { id: 3, asOf: "2026-01-07" },
      { id: 1, slug: "bushy", asOf: "2026-01-06" },
      { id: 1, slug: "bushy", asOf: "2026-01-07" },
    ]);

    assertEquals(results[0]?.status, "FOUND");
    assertEquals(results[0]?.requestedId, 1);
    assertEquals(results[0]?.requestedSlug, null);
    assertEquals(results[0]?.event?.slug, "bushy");

    assertEquals(results[1]?.status, "FOUND");
    assertEquals(results[1]?.requestedId, 1);
    assertEquals(results[1]?.event?.slug, "bushy-park");

    assertEquals(results[2]?.status, "FOUND");
    assertEquals(results[2]?.requestedId, 2);
    assertEquals(results[2]?.event?.slug, "richmond");

    assertEquals(results[3]?.status, "NOT_FOUND");
    assertEquals(results[3]?.requestedId, 2);
    assertEquals(results[3]?.event, null);

    assertEquals(results[4]?.status, "NOT_FOUND");
    assertEquals(results[4]?.requestedId, 3);
    assertEquals(results[4]?.event, null);

    assertEquals(results[5]?.status, "FOUND");
    assertEquals(results[5]?.requestedId, 3);
    assertEquals(results[5]?.event?.slug, "wimbledon");

    assertEquals(results[6]?.status, "FOUND");
    assertEquals(results[6]?.requestedId, 1);
    assertEquals(results[6]?.requestedSlug, "bushy");
    assertEquals(results[6]?.event?.slug, "bushy");

    assertEquals(results[7]?.status, "NOT_FOUND");
    assertEquals(results[7]?.requestedId, 1);
    assertEquals(results[7]?.requestedSlug, "bushy");
    assertEquals(results[7]?.event, null);
  } finally {
    kv.close();
  }
});

Deno.test("KvArchive supports batch lookup with a mix of id and slug inputs", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    const revision = await buildRevision([
      event(10, "ten"),
      event(20, "twenty"),
      event(30, "thirty"),
    ]);
    await archive.stageRevision(revision);
    const control = await archive.readControl("2026-01-06");
    assert(
      await archive.commitObservation(control, {
        date: "2026-01-06",
        fetchedAt: "2026-01-06T03:00:00.000Z",
        revisionHash: revision.hash,
        eventCount: 3,
        sourceEtag: null,
        changeSetHash: null,
        confirmedAnomaly: false,
      }),
    );

    const batch = [
      { id: 10, asOf: "2026-01-06" },
      { slug: "thirty", asOf: "2026-01-06" },
      { id: 20, asOf: "2026-01-06" },
      { id: 10, asOf: "2026-01-06" },
      { id: 999, asOf: "2026-01-06" },
      { slug: "missing", asOf: "2026-01-06" },
    ];
    const results = await archive.lookupMany(batch);
    assertEquals(results.length, 6);
    assertEquals(
      results.map((
        r,
      ) => [r.status, r.requestedId, r.requestedSlug, r.event?.id]),
      [
        ["FOUND", 10, null, 10],
        ["FOUND", null, "thirty", 30],
        ["FOUND", 20, null, 20],
        ["FOUND", 10, null, 10],
        ["NOT_FOUND", 999, null, undefined],
        ["NOT_FOUND", null, "missing", undefined],
      ],
    );
  } finally {
    kv.close();
  }
});

Deno.test("KvArchive supports fallbackToEarliest for pre-archive dates", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    const baseline = await buildRevision([event(1, "bushy")]);
    await archive.stageRevision(baseline);
    const control = await archive.readControl("2026-01-06");
    assert(
      await archive.commitObservation(control, {
        date: "2026-01-06",
        fetchedAt: "2026-01-06T03:00:00.000Z",
        revisionHash: baseline.hash,
        eventCount: 1,
        sourceEtag: null,
        changeSetHash: null,
        confirmedAnomaly: false,
      }),
    );

    const [withFallback, withoutFallback, missingWithFallback] = await archive
      .lookupMany([
        { id: 1, asOf: "2020-01-01" },
        { id: 1, asOf: "2020-01-01", fallbackToEarliest: false },
        { id: 999, asOf: "2020-01-01", fallbackToEarliest: true },
      ]);

    assertEquals(withFallback, {
      status: "FOUND",
      requestedId: 1,
      requestedSlug: null,
      requestedDate: "2020-01-01",
      observation: {
        date: "2026-01-06",
        fetchedAt: "2026-01-06T03:00:00.000Z",
      },
      event: event(1, "bushy"),
    });

    assertEquals(withoutFallback, {
      status: "NO_ARCHIVE_COVERAGE",
      requestedId: 1,
      requestedSlug: null,
      requestedDate: "2020-01-01",
      observation: null,
      event: null,
    });

    assertEquals(missingWithFallback, {
      status: "NOT_FOUND",
      requestedId: 999,
      requestedSlug: null,
      requestedDate: "2020-01-01",
      observation: {
        date: "2026-01-06",
        fetchedAt: "2026-01-06T03:00:00.000Z",
      },
      event: null,
    });
  } finally {
    kv.close();
  }
});

Deno.test("KvArchive rejects invalid lookup inputs", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    await assertRejects(
      () => archive.lookupMany([{ asOf: "2026-01-06" }]),
      RangeError,
      "must provide an id or slug",
    );
    await assertRejects(
      () => archive.lookupMany([{ id: 0, asOf: "2026-01-06" }]),
      RangeError,
      "positive integer",
    );
    await assertRejects(
      () => archive.lookupMany([{ id: -10, asOf: "2026-01-06" }]),
      RangeError,
      "positive integer",
    );
  } finally {
    kv.close();
  }
});

Deno.test("KvArchive getCountries and getArchiveInfo expose active country metadata", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    const day1 = await buildRevision([
      event(1, "bushy", 97),
      event(2, "albert", 3),
      event(3, "delta", 14),
    ]);
    await archive.stageRevision(day1);
    let control = await archive.readControl("2026-01-06");
    assert(
      await archive.commitObservation(control, {
        date: "2026-01-06",
        fetchedAt: "2026-01-06T03:00:00.000Z",
        revisionHash: day1.hash,
        eventCount: 3,
        sourceEtag: null,
        changeSetHash: null,
        confirmedAnomaly: false,
      }),
    );

    const day2 = await buildRevision([
      event(1, "bushy", 97),
      event(2, "albert", 3),
      event(4, "tokyo", 42),
    ]);
    await archive.stageRevision(day2);
    const changeSetHash = await archive.stageChangeSet(
      day1.hash,
      day2.hash,
      diffRevisions(day1, day2),
    );
    control = await archive.readControl("2026-01-07");
    assert(
      await archive.commitObservation(control, {
        date: "2026-01-07",
        fetchedAt: "2026-01-07T03:00:00.000Z",
        revisionHash: day2.hash,
        eventCount: 3,
        sourceEtag: null,
        changeSetHash,
        confirmedAnomaly: false,
      }),
    );

    const info = await archive.getArchiveInfo();
    assertEquals(info.latestCountryCodes, [3, 42, 97]);

    const latestCountries = await archive.getCountries();
    assertEquals(latestCountries, [
      { code: 3, url: "https://www.parkrun.example/3", eventCount: 1 },
      { code: 42, url: "https://www.parkrun.example/42", eventCount: 1 },
      { code: 97, url: "https://www.parkrun.org.uk", eventCount: 1 },
    ]);

    const historicalCountries = await archive.getCountries("2026-01-06");
    assertEquals(historicalCountries.map((c) => c.code), [3, 14, 97]);

    const preArchiveCountries = await archive.getCountries("2020-01-01");
    assertEquals(preArchiveCountries.map((c) => c.code), [3, 14, 97]);
  } finally {
    kv.close();
  }
});

Deno.test("KvArchive self-heals unindexed legacy revisions during lookupMany", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    const legacy = await buildRevision([
      event(100, "legacy-one"),
      event(200, "legacy-two"),
    ]);
    await archive.stageRevision(legacy);

    // Simulate a legacy revision by removing revision-countries and revision-id keys
    await kv.delete([
      "parkrun-events",
      "v1",
      "revision-countries",
      legacy.hash,
    ]);
    await kv.delete(["parkrun-events", "v1", "revision-id", legacy.hash, 100]);
    await kv.delete(["parkrun-events", "v1", "revision-id", legacy.hash, 200]);

    const control = await archive.readControl("2026-01-06");
    assert(
      await archive.commitObservation(control, {
        date: "2026-01-06",
        fetchedAt: "2026-01-06T03:00:00.000Z",
        revisionHash: legacy.hash,
        eventCount: 2,
        sourceEtag: null,
        changeSetHash: null,
        confirmedAnomaly: false,
      }),
    );

    // Querying by ID should self-heal and find the event
    const results = await archive.lookupMany([
      { id: 100, asOf: "2026-01-06" },
      { id: 999, asOf: "2026-01-06" },
    ]);

    assertEquals(results[0]?.status, "FOUND");
    assertEquals(results[0]?.event?.slug, "legacy-one");
    assertEquals(results[1]?.status, "NOT_FOUND");

    // Verify the index keys were written into KV
    const idKeyCheck = await kv.get([
      "parkrun-events",
      "v1",
      "revision-id",
      legacy.hash,
      100,
    ]);
    assertExists(idKeyCheck.value);

    const countryKeyCheck = await kv.get([
      "parkrun-events",
      "v1",
      "revision-countries",
      legacy.hash,
    ]);
    assertExists(countryKeyCheck.value);
  } finally {
    kv.close();
  }
});

Deno.test("KvArchive backfillIndexes idempotently indexes historical observations", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    const rev1 = await buildRevision([event(1, "first")]);
    const rev2 = await buildRevision([event(1, "first"), event(2, "second")]);
    await archive.stageRevision(rev1);
    await archive.stageRevision(rev2);

    // Remove the new keys to simulate legacy state
    await kv.delete(["parkrun-events", "v1", "revision-countries", rev1.hash]);
    await kv.delete(["parkrun-events", "v1", "revision-id", rev1.hash, 1]);
    await kv.delete(["parkrun-events", "v1", "revision-countries", rev2.hash]);
    await kv.delete(["parkrun-events", "v1", "revision-id", rev2.hash, 1]);
    await kv.delete(["parkrun-events", "v1", "revision-id", rev2.hash, 2]);

    let control = await archive.readControl("2026-01-06");
    assert(
      await archive.commitObservation(control, {
        date: "2026-01-06",
        fetchedAt: "2026-01-06T03:00:00.000Z",
        revisionHash: rev1.hash,
        eventCount: 1,
        sourceEtag: null,
        changeSetHash: null,
        confirmedAnomaly: false,
      }),
    );

    const changeSetHash = await archive.stageChangeSet(
      rev1.hash,
      rev2.hash,
      diffRevisions(rev1, rev2),
    );
    control = await archive.readControl("2026-01-07");
    assert(
      await archive.commitObservation(control, {
        date: "2026-01-07",
        fetchedAt: "2026-01-07T03:00:00.000Z",
        revisionHash: rev2.hash,
        eventCount: 2,
        sourceEtag: null,
        changeSetHash,
        confirmedAnomaly: false,
      }),
    );

    const report1 = await archive.backfillIndexes();
    assertEquals(report1.totalObservations, 2);
    assertEquals(report1.totalRevisions, 2);
    assertEquals(report1.newlyIndexedRevisions, 2);

    // Second run should find 0 newly indexed revisions
    const report2 = await archive.backfillIndexes();
    assertEquals(report2.totalObservations, 2);
    assertEquals(report2.totalRevisions, 2);
    assertEquals(report2.newlyIndexedRevisions, 0);
  } finally {
    kv.close();
  }
});
