import { assertEquals, assertRejects } from "@std/assert";
import { IngestionService } from "../src/ingest.ts";
import { KvArchive } from "../src/kv_archive.ts";
import type { EventRecord } from "../src/model.ts";
import type { FetchedCatalogue } from "../src/source.ts";

function event(id: number, slug = `event-${id}`): EventRecord {
  return {
    id,
    slug,
    name: slug,
    shortName: slug,
    localisedName: null,
    location: slug,
    latitude: 0,
    longitude: 0,
    countryCode: 97,
    countryUrl: "https://www.parkrun.org.uk",
    seriesId: 1,
  };
}

function fetched(
  events: readonly EventRecord[],
  date: string,
): FetchedCatalogue {
  return {
    events,
    fetchedAt: `${date}T03:00:00.000Z`,
    etag: null,
  };
}

Deno.test("IngestionService accepts a baseline and a normal update", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    const baseline = Array.from({ length: 20 }, (_, index) => event(index + 1));
    const updated = baseline.map((item) =>
      item.id === 1 ? event(1, "renamed") : item
    );
    const queue = [
      fetched(baseline, "2026-08-01"),
      fetched(updated, "2026-08-02"),
    ];
    const service = new IngestionService(
      archive,
      () => Promise.resolve(queue.shift()!),
    );

    assertEquals(await service.run("2026-08-01"), {
      status: "ACCEPTED",
      date: "2026-08-01",
      eventCount: 20,
      changeCount: 0,
      confirmedAnomaly: false,
    });
    assertEquals(await service.run("2026-08-02"), {
      status: "ACCEPTED",
      date: "2026-08-02",
      eventCount: 20,
      changeCount: 1,
      confirmedAnomaly: false,
    });
  } finally {
    kv.close();
  }
});

Deno.test("IngestionService confirms a mass change on a later valid run", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    const baseline = Array.from(
      { length: 202 },
      (_, index) => event(index + 1),
    );
    const massCandidate = baseline.slice(101);
    const confirmingCandidate = [...massCandidate, event(999, "unrelated-new")];
    const queue = [
      fetched(baseline, "2026-08-01"),
      fetched(massCandidate, "2026-08-02"),
      fetched(confirmingCandidate, "2026-08-03"),
    ];
    const service = new IngestionService(
      archive,
      () => Promise.resolve(queue.shift()!),
    );

    await service.run("2026-08-01");
    assertEquals(await service.run("2026-08-02"), {
      status: "PENDING_CONFIRMATION",
      date: "2026-08-02",
      eventCount: 101,
      changeCount: 101,
    });
    assertEquals(await service.run("2026-08-03"), {
      status: "ACCEPTED",
      date: "2026-08-03",
      eventCount: 102,
      changeCount: 102,
      confirmedAnomaly: true,
    });

    const [missing, present] = await archive.lookupMany([
      { slug: "event-1", asOf: "2026-08-03" },
      { slug: "unrelated-new", asOf: "2026-08-03" },
    ]);
    assertEquals(missing!.status, "NOT_FOUND");
    assertEquals(present!.status, "FOUND");
  } finally {
    kv.close();
  }
});

Deno.test("a failed fetch leaves a pending anomaly intact", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    const baseline = Array.from(
      { length: 202 },
      (_, index) => event(index + 1),
    );
    const candidate = baseline.slice(101);
    let call = 0;
    const service = new IngestionService(archive, () => {
      call += 1;
      if (call === 1) return Promise.resolve(fetched(baseline, "2026-08-01"));
      if (call === 2) return Promise.resolve(fetched(candidate, "2026-08-02"));
      if (call === 3) return Promise.reject(new Error("network down"));
      return Promise.resolve(fetched(candidate, "2026-08-04"));
    });

    await service.run("2026-08-01");
    await service.run("2026-08-02");
    await assertRejects(() => service.run("2026-08-03"), Error, "network down");
    assertEquals(
      (await archive.readControl("2026-08-04")).pending.value?.firstSeenDate,
      "2026-08-02",
    );
    assertEquals((await service.run("2026-08-04")).status, "ACCEPTED");
  } finally {
    kv.close();
  }
});
