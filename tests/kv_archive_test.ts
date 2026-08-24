import { assert, assertEquals } from "@std/assert";
import { KvArchive } from "../src/kv_archive.ts";
import { buildRevision, diffRevisions } from "../src/model.ts";
import type { EventRecord } from "../src/model.ts";

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
      ],
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
      through: "2026-08-31",
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
  } finally {
    kv.close();
  }
});

Deno.test("KvArchive rejects stale atomic publication", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    const first = await buildRevision([event(1, "first")]);
    const second = await buildRevision([event(2, "second")]);
    await archive.stageRevision(first);
    await archive.stageRevision(second);
    const stale = await archive.readControl("2026-08-01");
    const winner = await archive.readControl("2026-08-01");

    assert(
      await archive.commitObservation(winner, {
        date: "2026-08-01",
        fetchedAt: "2026-08-01T03:00:00.000Z",
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
  } finally {
    kv.close();
  }
});
