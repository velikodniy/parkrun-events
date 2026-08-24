import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  ChangeReadModel,
  ChangeViewNotReadyError,
} from "../src/change_views.ts";
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

Deno.test("change views answer global, country, and event history directly", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    const views = new ChangeReadModel(kv);
    await publish(
      archive,
      [event(1, "one"), event(2, "two")],
      "2026-08-01",
    );
    await publish(
      archive,
      [event(1, "one-moved", 3), event(3, "three")],
      "2026-08-02",
    );

    const validation = await views.synchronize(archive, {
      apply: false,
      fromBeginning: true,
    });
    assertEquals(validation.changeDates, 1);
    assertEquals(validation.changedEvents, 3);
    assertEquals(await views.getWatermark(), null);

    const applied = await views.synchronize(archive, { apply: true });
    assertEquals(applied.changeDates, 1);
    assertEquals(await views.getWatermark(), "2026-08-02");

    const global = await views.listCatalogueChanges({ first: 10 });
    assertEquals(global.nodes.length, 1);
    assertEquals(global.nodes[0]?.counts, {
      appeared: 1,
      disappeared: 1,
      updated: 1,
    });
    const summary = global.nodes[0]!;
    assertEquals(
      (await views.getEventChanges(summary, "appeared", { first: 10 }))
        .nodes.map((node) => node.id),
      [3],
    );
    assertEquals(
      (await views.getEventChanges(summary, "disappeared", { first: 10 }))
        .nodes.map((node) => node.id),
      [2],
    );
    assertEquals(
      (await views.getEventChanges(summary, "updated", { first: 10 })).nodes
        .map((node) => [
          node.id,
          node.before?.countryCode,
          node.after?.countryCode,
        ]),
      [[1, 97, 3]],
    );

    const oldCountry = await views.listCatalogueChanges({
      countryCode: 97,
      first: 10,
    });
    assertEquals(oldCountry.nodes[0]?.counts, {
      appeared: 1,
      disappeared: 1,
      updated: 1,
    });
    const newCountry = await views.listCatalogueChanges({
      countryCode: 3,
      first: 10,
    });
    assertEquals(newCountry.nodes[0]?.counts, {
      appeared: 0,
      disappeared: 0,
      updated: 1,
    });
    assertEquals(
      await views.listCatalogueChanges({ countryCode: 44, first: 10 }),
      { nodes: [], endDate: null, hasNextPage: false },
    );

    const history = await views.listEventChanges({ eventId: 1, first: 10 });
    assertEquals(history.nodes.length, 1);
    assertEquals(history.nodes[0]?.kind, "updated");
    assertEquals(history.nodes[0]?.before?.slug, "one");
    assertEquals(history.nodes[0]?.after?.slug, "one-moved");
    assertEquals(
      await views.listEventChanges({ eventId: 999, first: 10 }),
      { nodes: [], endDate: null, hasNextPage: false },
    );

    const meter = readMeter(kv);
    const meteredViews = new ChangeReadModel(meter.kv);
    const meteredPage = await meteredViews.listCatalogueChanges({ first: 10 });
    for (const kind of ["appeared", "disappeared", "updated"] as const) {
      await meteredViews.getEventChanges(meteredPage.nodes[0]!, kind, {
        first: 50,
      });
    }
    assertEquals(meter.readUnits, 5);

    await publish(
      archive,
      [event(1, "one-moved", 3), event(3, "three")],
      "2026-08-03",
    );
    const noChange = await views.synchronize(archive, { apply: true });
    assertEquals(noChange.changeDates, 0);
    assertEquals(await views.getWatermark(), "2026-08-03");
    assertEquals(
      (await views.listCatalogueChanges({ first: 10 })).nodes.length,
      1,
    );

    const repeated = await views.synchronize(archive, { apply: true });
    assertEquals(repeated.changeDates, 0);
    assertEquals(repeated.records, 0);
  } finally {
    kv.close();
  }
});

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
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  return Math.max(1, Math.ceil(bytes / 4_096));
}

Deno.test("staged change views remain hidden until their watermark publishes", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    const views = new ChangeReadModel(kv);
    await publish(archive, [event(1, "old")], "2026-08-01");
    await publish(archive, [event(1, "new")], "2026-08-02");

    await views.synchronize(archive, { apply: true, publish: false });
    await assertRejects(
      () => views.listCatalogueChanges({ first: 10 }),
      ChangeViewNotReadyError,
    );

    const resumed = await views.synchronize(archive, { apply: true });
    assertEquals(resumed.changeDates, 1);
    assertEquals(
      (await views.listCatalogueChanges({ first: 10 })).nodes.length,
      1,
    );
  } finally {
    kv.close();
  }
});

Deno.test("materialized detail pages target one 4 KiB read unit", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    const views = new ChangeReadModel(kv);
    const longText = "界".repeat(256);
    const before = Array.from(
      { length: 20 },
      (_, index) => event(index + 1, `event-${index + 1}`),
    );
    const after = before.map((item) =>
      event(
        item.id,
        `${item.slug}-new`,
        97,
        `${longText}${item.id}`,
      )
    );
    await publish(archive, before, "2026-08-01");
    await publish(archive, after, "2026-08-02");
    await views.synchronize(archive, { apply: true });

    let detailPages = 0;
    for await (
      const entry of kv.list<unknown>({
        prefix: ["parkrun-events", "read-v2", "detail", "all"],
      })
    ) {
      detailPages += 1;
      const encodedBytes = new TextEncoder().encode(JSON.stringify(entry.value))
        .byteLength;
      assert(encodedBytes <= 48 * 1024);
      const record = entry.value as { n: unknown[] };
      assert(encodedBytes <= 3_500 || record.n.length === 1);
    }
    assert(detailPages > 1);

    const summary = (await views.listCatalogueChanges({ first: 10 })).nodes[0]!;
    const ids: number[] = [];
    let afterPosition = undefined;
    while (true) {
      const page = await views.getEventChanges(summary, "updated", {
        first: 5,
        ...(afterPosition === undefined ? {} : { after: afterPosition }),
      });
      ids.push(...page.nodes.map((node) => node.id));
      if (!page.hasNextPage || page.endPosition === null) break;
      afterPosition = page.endPosition;
    }
    assertEquals(ids, Array.from({ length: 20 }, (_, index) => index + 1));
  } finally {
    kv.close();
  }
});
