import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  ChangeFeed,
  ChangeFeedNotReadyError,
  type FeedCatalogueChangeSummary,
} from "../src/change_feed.ts";
import { ChangeReadModel } from "../src/change_views.ts";
import { createGraphqlServer } from "../src/graphql.ts";
import { KvArchive } from "../src/kv_archive.ts";
import { buildRevision, diffRevisions } from "../src/model.ts";
import type { EventRecord } from "../src/model.ts";

function event(
  id: number,
  slug: string,
  countryCode = 97,
  text = slug,
): EventRecord {
  return {
    id,
    slug,
    name: `${text} parkrun`,
    shortName: text,
    localisedName: null,
    location: `${text} park`,
    latitude: 51,
    longitude: -1,
    countryCode,
    countryUrl: countryCode === 97
      ? "https://www.parkrun.org.uk"
      : "https://www.parkrun.example",
    seriesId: 1,
  };
}

async function publish(
  archive: KvArchive,
  events: readonly EventRecord[],
  date: string,
): Promise<void> {
  const revision = await buildRevision(events);
  const control = await archive.readControl(date);
  let changeSetHash: string | null = null;
  if (control.head.value !== null) {
    const previous = await archive.loadRevision(
      control.head.value.revisionHash,
    );
    await archive.stageRevision(revision);
    const diff = diffRevisions(previous, revision);
    if (
      diff.appeared.length + diff.disappeared.length + diff.updated.length > 0
    ) {
      changeSetHash = await archive.stageChangeSet(
        previous.hash,
        revision.hash,
        diff,
      );
    }
  } else {
    await archive.stageRevision(revision);
  }
  assert(
    await archive.commitObservation(control, {
      date,
      fetchedAt: `${date}T03:00:00.000Z`,
      revisionHash: revision.hash,
      eventCount: events.length,
      sourceEtag: null,
      changeSetHash,
      confirmedAnomaly: false,
    }),
  );
}

async function buildViews(
  kv: Deno.Kv,
  archive: KvArchive,
): Promise<ChangeReadModel> {
  const views = new ChangeReadModel(kv);
  await views.synchronize(archive, { apply: true });
  return views;
}

Deno.test("packed change feed serves global and country pages without detail reads", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    await publish(
      archive,
      [event(1, "one"), event(2, "two")],
      "2026-01-01",
    );
    await publish(
      archive,
      [event(1, "one-moved", 3), event(3, "three")],
      "2026-01-07",
    );
    await publish(
      archive,
      [event(1, "one-renamed", 3), event(3, "three")],
      "2026-03-07",
    );
    const views = await buildViews(kv, archive);
    const feed = new ChangeFeed(kv);

    const validation = await feed.synchronize(views, {
      apply: false,
      fromBeginning: true,
    });
    assertEquals(validation.changeDates, 2);
    assertEquals(await feed.getWatermark(), null);

    const applied = await feed.synchronize(views, { apply: true });
    assertEquals(applied.changeDates, 2);
    assertEquals(await feed.getWatermark(), "2026-03-07");

    const first = await feed.listCatalogueChanges({ first: 1 });
    assertEquals(first.nodes.length, 1);
    assertEquals(first.nodes[0]?.observation.date, "2026-01-07");
    assertEquals(first.hasNextPage, true);
    const firstSummary = first.nodes[0] as FeedCatalogueChangeSummary;
    assertEquals(
      feed.getEventChanges(firstSummary, "appeared", { first: 50 }).nodes.map(
        (node) => node.id,
      ),
      [3],
    );
    assertEquals(
      feed.getEventChanges(firstSummary, "disappeared", { first: 50 }).nodes
        .map((node) => node.id),
      [2],
    );
    assertEquals(
      feed.getEventChanges(firstSummary, "updated", { first: 50 }).nodes.map(
        (node) => [node.id, node.before?.countryCode, node.after?.countryCode],
      ),
      [[1, 97, 3]],
    );

    const second = await feed.listCatalogueChanges({
      first: 1,
      afterDate: first.endDate!,
    });
    assertEquals(second.nodes[0]?.observation.date, "2026-03-07");
    assertEquals(second.hasNextPage, false);

    const oldCountry = await feed.listCatalogueChanges({
      countryCode: 97,
      first: 10,
    });
    assertEquals(oldCountry.nodes.length, 1);
    assertEquals(oldCountry.nodes[0]?.counts, {
      appeared: 1,
      disappeared: 1,
      updated: 1,
    });
    const newCountry = await feed.listCatalogueChanges({
      countryCode: 3,
      first: 10,
    });
    assertEquals(newCountry.nodes.length, 2);

    const meter = readMeter(kv);
    const meteredFeed = new ChangeFeed(meter.kv);
    const meteredPage = await meteredFeed.listCatalogueChanges({ first: 20 });
    for (const summary of meteredPage.nodes) {
      for (const kind of ["appeared", "disappeared", "updated"] as const) {
        meteredFeed.getEventChanges(
          summary as FeedCatalogueChangeSummary,
          kind,
          { first: 50 },
        );
      }
    }
    assertEquals(meter.readUnits, 3);

    const graphqlMeter = readMeter(kv);
    const server = createGraphqlServer(
      new KvArchive(graphqlMeter.kv),
      new ChangeReadModel(graphqlMeter.kv),
      new ChangeFeed(graphqlMeter.kv),
    );
    const query = `
      query Changes($after: String) {
        catalogueChanges(first: 1, after: $after) {
          nodes {
            appeared { nodes { after { id slug } } }
            disappeared { nodes { before { id slug } } }
            updated { nodes { before { id slug } after { id slug } } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    const firstResponse = await execute(server, query);
    const firstConnection = (firstResponse.data as Record<string, unknown>)
      .catalogueChanges as Record<string, unknown>;
    const firstPageInfo = firstConnection.pageInfo as Record<string, unknown>;
    assertEquals(firstPageInfo.hasNextPage, true);
    assertEquals(graphqlMeter.readUnits, 3);
    const secondResponse = await execute(server, query, {
      after: firstPageInfo.endCursor,
    });
    const secondConnection = (secondResponse.data as Record<string, unknown>)
      .catalogueChanges as Record<string, unknown>;
    assertEquals(
      (secondConnection.pageInfo as Record<string, unknown>).hasNextPage,
      false,
    );
    assertEquals(graphqlMeter.readUnits, 5);
  } finally {
    kv.close();
  }
});

Deno.test("packed feed updates remain hidden until watermark publication", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    await publish(archive, [event(1, "old")], "2026-08-01");
    await publish(archive, [event(1, "new")], "2026-08-02");
    const views = await buildViews(kv, archive);
    const feed = new ChangeFeed(kv);

    await feed.synchronize(views, { apply: true, publish: false });
    await assertRejects(
      () => feed.listCatalogueChanges({ first: 10 }),
      ChangeFeedNotReadyError,
    );
    await feed.synchronize(views, { apply: true });
    assertEquals(
      (await feed.listCatalogueChanges({ first: 10 })).nodes.length,
      1,
    );
  } finally {
    kv.close();
  }
});

Deno.test("concurrent packed-feed synchronizers converge idempotently", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    await publish(archive, [event(1, "old")], "2026-08-01");
    await publish(archive, [event(1, "new")], "2026-08-02");
    const views = await buildViews(kv, archive);
    const first = new ChangeFeed(kv);
    const second = new ChangeFeed(kv);
    await Promise.all([
      first.synchronize(views, { apply: true }),
      second.synchronize(views, { apply: true }),
    ]);
    assertEquals(await first.getWatermark(), "2026-08-02");
    const page = await first.listCatalogueChanges({ first: 10 });
    assertEquals(page.nodes.length, 1);
    assertEquals(page.nodes[0]?.counts.updated, 1);
  } finally {
    kv.close();
  }
});

Deno.test("packed feed rejects corrupted compressed payloads", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    await publish(archive, [event(1, "old")], "2026-08-01");
    await publish(archive, [event(1, "new")], "2026-08-02");
    const views = await buildViews(kv, archive);
    const feed = new ChangeFeed(kv);
    await feed.synchronize(views, { apply: true });
    const key: Deno.KvKey = [
      "parkrun-events",
      "read-v3",
      "feed",
      "all",
      "2026-08",
    ];
    const stored = await kv.get<Uint8Array>(key);
    assert(stored.value instanceof Uint8Array);
    const corrupted = Uint8Array.from(stored.value);
    const lastIndex = corrupted.length - 1;
    corrupted[lastIndex] = corrupted[lastIndex]! ^ 0xff;
    await kv.set(key, corrupted);
    await assertRejects(
      () => feed.listCatalogueChanges({ first: 10 }),
      Error,
    );
  } finally {
    kv.close();
  }
});

Deno.test("packed feed falls back when an inline month compresses above 48 KiB", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    const before = Array.from(
      { length: 22 },
      (_, index) => noisyEvent(index + 1, `event-${index + 1}`, index),
    );
    const after = before.map((item, index) =>
      noisyEvent(item.id, `${item.slug}-new`, index + 10_000)
    );
    await publish(archive, before, "2026-08-01");
    await publish(archive, after, "2026-08-02");
    const views = await buildViews(kv, archive);
    const feed = new ChangeFeed(kv);
    await feed.synchronize(views, { apply: true });

    const month = await kv.get<unknown>([
      "parkrun-events",
      "read-v3",
      "feed",
      "all",
      "2026-08",
    ]);
    assert(month.value !== null);
    assert(!(month.value instanceof Uint8Array));
    assertEquals(
      (await feed.listCatalogueChanges({ first: 10 })).nodes[0]?.counts.updated,
      22,
    );
  } finally {
    kv.close();
  }
});

Deno.test("packed feed splits incompressible months below one read unit", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    const before = Array.from(
      { length: 100 },
      (_, index) => event(index + 1, `event-${index + 1}`, 97, noise(index)),
    );
    const after = before.map((item, index) =>
      event(item.id, `${item.slug}-new`, 97, noise(index + 10_000))
    );
    await publish(archive, before, "2026-08-01");
    await publish(archive, after, "2026-08-02");
    const views = await buildViews(kv, archive);
    const feed = new ChangeFeed(kv);
    await feed.synchronize(views, { apply: true });

    const month = await kv.get<unknown>([
      "parkrun-events",
      "read-v3",
      "feed",
      "all",
      "2026-08",
    ]);
    assert(month.value !== null);
    if (!(month.value instanceof Uint8Array)) {
      const directory = month.value as { p: number; g: string };
      assert(directory.p > 1);
      for (let page = 0; page < directory.p; page += 1) {
        const stored = await kv.get<Uint8Array>([
          "parkrun-events",
          "read-v3",
          "page",
          "all",
          "2026-08",
          directory.g,
          page,
        ]);
        assert(stored.value !== null);
        assert(stored.value.byteLength <= 3_500);
      }
    } else {
      assert(month.value.byteLength <= 3_500);
    }
    const result = await feed.listCatalogueChanges({ first: 10 });
    assertEquals(result.nodes[0]?.counts.updated, 100);
  } finally {
    kv.close();
  }
});

async function execute(
  server: ReturnType<typeof createGraphqlServer>,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await server.fetch(
    new Request("http://localhost/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    }),
  );
  return await response.json() as Record<string, unknown>;
}

function noisyEvent(id: number, slug: string, seed: number): EventRecord {
  return {
    id,
    slug,
    name: noise(seed),
    shortName: noise(seed + 1_000),
    localisedName: noise(seed + 2_000),
    location: noise(seed + 3_000),
    latitude: 51,
    longitude: -1,
    countryCode: 97,
    countryUrl: `https://${noise(seed + 4_000)}.example`,
    seriesId: 1,
  };
}

function noise(seed: number): string {
  let state = seed + 1;
  let result = "";
  for (let index = 0; index < 256; index += 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    result += String.fromCharCode(33 + state % 90);
  }
  return result;
}

function readMeter(source: Deno.Kv): {
  readonly kv: Deno.Kv;
  readonly readUnits: number;
} {
  let readUnits = 0;
  const proxy = new Proxy(source, {
    get(target, property) {
      if (property === "get") {
        return async (
          key: Deno.KvKey,
          options?: { readonly consistency?: "strong" | "eventual" },
        ) => {
          const entry = await target.get(key, options);
          readUnits += units(entry.value);
          return entry;
        };
      }
      if (property === "getMany") {
        return async (
          keys: [Deno.KvKey, ...Deno.KvKey[]],
          options?: { readonly consistency?: "strong" | "eventual" },
        ) => {
          const entries = await target.getMany(keys, options);
          for (const entry of entries) readUnits += units(entry.value);
          return entries;
        };
      }
      if (property === "list") {
        return (
          selector: Deno.KvListSelector,
          options?: Deno.KvListOptions,
        ) => {
          const iterator = target.list(selector, options);
          return {
            get cursor() {
              return iterator.cursor;
            },
            async *[Symbol.asyncIterator]() {
              for await (const entry of iterator) {
                readUnits += units(entry.value);
                yield entry;
              }
            },
          };
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Deno.Kv;
  return {
    kv: proxy,
    get readUnits() {
      return readUnits;
    },
  };
}

function units(value: unknown): number {
  if (value instanceof Uint8Array) {
    return Math.max(1, Math.ceil(value.byteLength / 4_096));
  }
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  return Math.max(1, Math.ceil(bytes / 4_096));
}
