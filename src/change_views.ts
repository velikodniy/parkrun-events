import type {
  CatalogueChangePage,
  CatalogueChangeSummary,
  ChangeKind,
  EventChangeNode,
  EventChangePage,
  PublicObservation,
} from "./archive.ts";
import { parseUtcDate } from "./date.ts";
import { KvArchive } from "./kv_archive.ts";
import {
  canonicalEventJson,
  type EventField,
  type EventRecord,
  sha256Hex,
} from "./model.ts";

const VIEW_PREFIX = ["parkrun-events", "change-views"] as const;
const WATERMARK_KEY = [...VIEW_PREFIX, "meta", "watermark"] as const;
const PAGE_TARGET_BYTES = 3_500;
const MAX_SAFE_VALUE_BYTES = 48 * 1024;
const MAX_BATCH_KEYS = 10;
const GRAPHQL_INT_MAX = 2_147_483_647;
const MAX_CHANGE_COUNT = 100_000;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;

const CHANGE_KINDS = ["appeared", "disappeared", "updated"] as const;
const EVENT_FIELDS = [
  "SLUG",
  "NAME",
  "SHORT_NAME",
  "LOCALISED_NAME",
  "LOCATION",
  "COORDINATES",
  "COUNTRY",
  "SERIES",
] as const satisfies readonly EventField[];

type StoredObservation = readonly [date: string, fetchedAt: string];
type StoredEvent = readonly [
  id: number,
  slug: string,
  name: string,
  shortName: string,
  localisedName: string | null,
  location: string,
  latitude: number,
  longitude: number,
  countryCode: number,
  countryUrl: string,
  seriesId: number,
];
type StoredChange = readonly [
  kind: number,
  id: number,
  beforeHash: string | null,
  afterHash: string | null,
  changedFieldMask: number,
  before: StoredEvent | null,
  after: StoredEvent | null,
];

interface StoredWatermark {
  readonly v: 1;
  readonly d: string;
}

interface StoredCatalogueHeader {
  readonly v: 1;
  readonly h: string;
  readonly o: StoredObservation;
  readonly p: StoredObservation;
  readonly c: readonly [number, number, number];
  readonly q: readonly [number, number, number];
  readonly a: boolean;
}

interface StoredDetailPage {
  readonly v: 1;
  readonly h: string;
  readonly k: number;
  readonly p: number;
  readonly n: readonly StoredChange[];
}

interface StoredEventOccurrence {
  readonly v: 1;
  readonly h: string;
  readonly o: StoredObservation;
  readonly p: StoredObservation;
  readonly a: boolean;
  readonly n: StoredChange;
}

interface DerivedItem {
  readonly key: Deno.KvKey;
  readonly value: unknown;
  readonly encoded: string;
}

export interface ViewCatalogueChangeSummary extends CatalogueChangeSummary {
  readonly viewCountryCode: number | null;
  readonly viewPageCounts: Readonly<Record<ChangeKind, number>>;
}

export interface ViewCatalogueChangePage extends CatalogueChangePage {
  readonly nodes: readonly ViewCatalogueChangeSummary[];
}

export interface ViewEventChangePosition {
  readonly page: number;
  readonly offset: number;
  readonly lastId: number;
}

export interface ViewEventChangePage extends EventChangePage {
  readonly endPosition: ViewEventChangePosition | null;
}

export interface EventHistoryNode {
  readonly kind: ChangeKind;
  readonly observation: PublicObservation;
  readonly previousObservation: PublicObservation;
  readonly before: EventRecord | null;
  readonly after: EventRecord | null;
  readonly changedFields: readonly EventField[];
  readonly confirmedAnomaly: boolean;
}

export interface EventHistoryPage {
  readonly nodes: readonly EventHistoryNode[];
  readonly endDate: string | null;
  readonly hasNextPage: boolean;
}

export interface ChangeViewSyncProgress {
  readonly position: number;
  readonly date: string;
  readonly changeCount: number;
  readonly applied: boolean;
}

export interface ChangeViewSyncReport {
  readonly throughDate: string | null;
  readonly changeDates: number;
  readonly changedEvents: number;
  readonly records: number;
  readonly bytes: number;
  readonly applied: boolean;
}

export class ChangeViewNotReadyError extends Error {
  constructor() {
    super("The materialized change view is not ready");
    this.name = "ChangeViewNotReadyError";
  }
}

export class ChangeReadModel {
  constructor(private readonly kv: Deno.Kv) {}

  async synchronize(
    archive: KvArchive,
    options: {
      readonly apply: boolean;
      readonly fromBeginning?: boolean;
      readonly publish?: boolean;
      readonly onProgress?: (progress: ChangeViewSyncProgress) => void;
    },
  ): Promise<ChangeViewSyncReport> {
    const info = await archive.getArchiveInfo();
    const targetDate = info.latestObservation?.date ?? null;
    const watermark = await this.readWatermarkEntry();
    const startDate = options.fromBeginning ? null : watermark.value?.d ?? null;
    if (
      targetDate !== null && watermark.value !== null &&
      watermark.value.d > targetDate
    ) {
      throw new Error(
        "Change-view watermark is ahead of the canonical archive",
      );
    }

    let afterDate = startDate;
    let changeDates = 0;
    let changedEvents = 0;
    let records = 0;
    let bytes = 0;
    while (targetDate !== null) {
      const page = await archive.listCatalogueChanges({
        first: 100,
        through: targetDate,
        ...(afterDate === null ? {} : { afterDate }),
      });
      for (const summary of page.nodes) {
        const changes = await loadAllChanges(archive, summary);
        const items = await deriveItems(summary, changes);
        if (options.apply) await this.putDerivedItems(items);
        changeDates += 1;
        const changeCount = countChanges(changes);
        changedEvents += changeCount;
        records += items.length;
        bytes += items.reduce(
          (total, item) => total + encodedBytes(item.encoded),
          0,
        );
        options.onProgress?.({
          position: changeDates,
          date: summary.observation.date,
          changeCount,
          applied: options.apply,
        });
      }
      if (!page.hasNextPage || page.endDate === null) break;
      afterDate = page.endDate;
    }

    if (options.apply && options.publish !== false && targetDate !== null) {
      await this.advanceWatermark(targetDate);
    }
    return {
      throughDate: targetDate,
      changeDates,
      changedEvents,
      records,
      bytes,
      applied: options.apply,
    };
  }

  async listCatalogueChanges(options: {
    readonly countryCode?: number;
    readonly from?: string;
    readonly through?: string;
    readonly first: number;
    readonly afterDate?: string;
  }): Promise<ViewCatalogueChangePage> {
    validatePageSize(options.first, "Change-set");
    const countryCode = options.countryCode === undefined
      ? null
      : validateCountryCode(options.countryCode);
    const from = options.from === undefined ? null : parseUtcDate(options.from);
    const through = options.through === undefined
      ? null
      : parseUtcDate(options.through);
    const afterDate = options.afterDate === undefined
      ? null
      : parseUtcDate(options.afterDate);
    if (from !== null && through !== null && from > through) {
      throw new RangeError(
        "Change-set start date must not follow its end date",
      );
    }
    const watermark = await this.requireWatermark();
    const effectiveThrough = through === null || through > watermark
      ? watermark
      : through;
    const startDate = afterDate === null
      ? from
      : from === null || afterDate >= from
      ? `${afterDate}\u0000`
      : from;
    if (startDate !== null && startDate > effectiveThrough) {
      return { nodes: [], endDate: null, hasNextPage: false };
    }

    const prefix = cataloguePrefix(countryCode);
    const endDate = `${effectiveThrough}\u0000`;
    const selector: Deno.KvListSelector = startDate === null
      ? { prefix, end: [...prefix, endDate] }
      : {
        start: [...prefix, startDate],
        end: [...prefix, endDate],
      };
    const rows: ViewCatalogueChangeSummary[] = [];
    const iterator = this.kv.list<unknown>(selector, {
      limit: options.first + 1,
      batchSize: Math.min(options.first + 1, 100),
      consistency: "strong",
    });
    for await (const entry of iterator) {
      const date = entry.key.at(-1);
      if (typeof date !== "string") {
        throw new Error("Change-view index has an invalid date key");
      }
      rows.push(decodeHeader(entry.value, date, countryCode));
    }
    const hasNextPage = rows.length > options.first;
    const nodes = rows.slice(0, options.first);
    return {
      nodes,
      endDate: nodes.at(-1)?.observation.date ?? null,
      hasNextPage,
    };
  }

  async getEventChanges(
    summary: ViewCatalogueChangeSummary,
    kind: ChangeKind,
    options: {
      readonly first: number;
      readonly after?: ViewEventChangePosition;
    },
  ): Promise<ViewEventChangePage> {
    validatePageSize(options.first, "Event-change");
    const pageCount = summary.viewPageCounts[kind];
    let pageIndex = options.after?.page ?? 0;
    let offset = options.after === undefined ? 0 : options.after.offset + 1;
    let firstPage: readonly EventChangeNode[] | null = null;
    if (options.after !== undefined) {
      if (options.after.page >= pageCount) {
        throw new Error("Materialized change cursor page is out of range");
      }
      firstPage = await this.readDetailPage(summary, kind, options.after.page);
      if (firstPage[options.after.offset]?.id !== options.after.lastId) {
        throw new Error("Materialized change cursor does not match its page");
      }
    }
    const selected: Array<{
      readonly node: EventChangeNode;
      readonly position: ViewEventChangePosition;
    }> = [];
    let previousId = options.after?.lastId ?? null;
    while (pageIndex < pageCount && selected.length <= options.first) {
      const nodes = firstPage ?? await this.readDetailPage(
        summary,
        kind,
        pageIndex,
      );
      firstPage = null;
      for (
        ;
        offset < nodes.length && selected.length <= options.first;
        offset++
      ) {
        const node = nodes[offset]!;
        if (previousId !== null && node.id <= previousId) {
          throw new Error("Materialized change pages are not globally ordered");
        }
        selected.push({
          node,
          position: { page: pageIndex, offset, lastId: node.id },
        });
        previousId = node.id;
      }
      pageIndex += 1;
      offset = 0;
    }
    const hasNextPage = selected.length > options.first;
    const returned = selected.slice(0, options.first);
    const nodes = returned.map((entry) => entry.node);
    return {
      nodes,
      endId: nodes.at(-1)?.id ?? null,
      hasNextPage,
      endPosition: returned.at(-1)?.position ?? null,
    };
  }

  async getAllEventChanges(
    summary: ViewCatalogueChangeSummary,
  ): Promise<Readonly<Record<ChangeKind, readonly EventChangeNode[]>>> {
    const result: Record<ChangeKind, EventChangeNode[]> = {
      appeared: [],
      disappeared: [],
      updated: [],
    };
    for (const kind of CHANGE_KINDS) {
      let after: ViewEventChangePosition | undefined;
      while (true) {
        const page = await this.getEventChanges(summary, kind, {
          first: 100,
          ...(after === undefined ? {} : { after }),
        });
        result[kind].push(...page.nodes);
        if (!page.hasNextPage || page.endPosition === null) break;
        after = page.endPosition;
      }
      if (result[kind].length !== summary.counts[kind]) {
        throw new Error(`Materialized ${kind} count is inconsistent`);
      }
    }
    return result;
  }

  private async readDetailPage(
    summary: ViewCatalogueChangeSummary,
    kind: ChangeKind,
    page: number,
  ): Promise<readonly EventChangeNode[]> {
    const entry = await this.kv.get<unknown>(
      detailKey(summary.viewCountryCode, summary.hash, kind, page),
      { consistency: "strong" },
    );
    if (entry.value === null) {
      throw new Error(`Missing materialized ${kind} page ${page}`);
    }
    return await decodeDetailPage(entry.value, summary.hash, kind, page);
  }

  async listEventChanges(options: {
    readonly eventId: number;
    readonly from?: string;
    readonly through?: string;
    readonly first: number;
    readonly afterDate?: string;
  }): Promise<EventHistoryPage> {
    validatePageSize(options.first, "Event-history");
    if (
      !Number.isSafeInteger(options.eventId) || options.eventId < 1 ||
      options.eventId > GRAPHQL_INT_MAX
    ) {
      throw new RangeError("Event ID must be a positive GraphQL integer");
    }
    const from = options.from === undefined ? null : parseUtcDate(options.from);
    const through = options.through === undefined
      ? null
      : parseUtcDate(options.through);
    const afterDate = options.afterDate === undefined
      ? null
      : parseUtcDate(options.afterDate);
    if (from !== null && through !== null && from > through) {
      throw new RangeError(
        "Event-history start date must not follow its end date",
      );
    }
    const watermark = await this.requireWatermark();
    const effectiveThrough = through === null || through > watermark
      ? watermark
      : through;
    const prefix = eventPrefix(options.eventId);
    const startDate = afterDate === null
      ? from
      : from === null || afterDate >= from
      ? `${afterDate}\u0000`
      : from;
    if (startDate !== null && startDate > effectiveThrough) {
      return { nodes: [], endDate: null, hasNextPage: false };
    }
    const selector: Deno.KvListSelector = startDate === null
      ? { prefix, end: [...prefix, `${effectiveThrough}\u0000`] }
      : {
        start: [...prefix, startDate],
        end: [...prefix, `${effectiveThrough}\u0000`],
      };
    const rows: EventHistoryNode[] = [];
    const iterator = this.kv.list<unknown>(selector, {
      limit: options.first + 1,
      batchSize: Math.min(options.first + 1, 100),
      consistency: "strong",
    });
    for await (const entry of iterator) {
      const date = entry.key.at(-1);
      if (typeof date !== "string") {
        throw new Error("Event-view index has an invalid date key");
      }
      rows.push(
        await decodeEventOccurrence(entry.value, date, options.eventId),
      );
    }
    const hasNextPage = rows.length > options.first;
    const nodes = rows.slice(0, options.first);
    return {
      nodes,
      endDate: nodes.at(-1)?.observation.date ?? null,
      hasNextPage,
    };
  }

  async getWatermark(): Promise<string | null> {
    return (await this.readWatermarkEntry()).value?.d ?? null;
  }

  private async requireWatermark(): Promise<string> {
    const watermark = await this.getWatermark();
    if (watermark === null) throw new ChangeViewNotReadyError();
    return watermark;
  }

  private async readWatermarkEntry(): Promise<
    Deno.KvEntryMaybe<StoredWatermark>
  > {
    const entry = await this.kv.get<unknown>(WATERMARK_KEY, {
      consistency: "strong",
    });
    if (entry.value === null) {
      return entry as Deno.KvEntryMaybe<StoredWatermark>;
    }
    const value = recordValue(entry.value, "change-view watermark");
    if (value.v !== 1 || typeof value.d !== "string") {
      throw new Error("Change-view watermark is invalid");
    }
    parseUtcDate(value.d);
    return { ...entry, value: { v: 1, d: value.d } };
  }

  private async advanceWatermark(targetDate: string): Promise<void> {
    parseUtcDate(targetDate);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.readWatermarkEntry();
      if (current.value !== null && current.value.d >= targetDate) return;
      const result = await this.kv.atomic()
        .check(current)
        .set(WATERMARK_KEY, { v: 1, d: targetDate } satisfies StoredWatermark)
        .commit();
      if (result.ok) return;
    }
    throw new Error("Could not advance the change-view watermark");
  }

  private async putDerivedItems(items: readonly DerivedItem[]): Promise<void> {
    for (let offset = 0; offset < items.length; offset += MAX_BATCH_KEYS) {
      await this.putDerivedChunk(
        items.slice(offset, offset + MAX_BATCH_KEYS),
        0,
      );
    }
  }

  private async putDerivedChunk(
    items: readonly DerivedItem[],
    attempt: number,
  ): Promise<void> {
    const entries = await this.kv.getMany(
      items.map((item) => item.key) as [Deno.KvKey, ...Deno.KvKey[]],
      { consistency: "strong" },
    );
    let atomic = this.kv.atomic();
    let mutations = 0;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      const entry = entries[index]!;
      if (entry.value !== null) {
        if (JSON.stringify(entry.value) !== item.encoded) {
          throw new Error(
            `Derived change-view key ${JSON.stringify(item.key)} conflicts`,
          );
        }
        continue;
      }
      atomic = atomic.check(entry).set(item.key, item.value);
      mutations += 1;
    }
    if (mutations === 0) return;
    const result = await atomic.commit();
    if (result.ok) return;
    if (attempt >= 2) {
      throw new Error("Could not stage derived change-view records");
    }
    await this.putDerivedChunk(items, attempt + 1);
  }
}

async function loadAllChanges(
  archive: KvArchive,
  summary: CatalogueChangeSummary,
): Promise<Readonly<Record<ChangeKind, readonly EventChangeNode[]>>> {
  const result: Record<ChangeKind, EventChangeNode[]> = {
    appeared: [],
    disappeared: [],
    updated: [],
  };
  for (const kind of CHANGE_KINDS) {
    let afterId: number | undefined;
    while (true) {
      const page = await archive.getEventChanges(summary.hash, kind, {
        first: 100,
        ...(afterId === undefined ? {} : { afterId }),
      });
      result[kind].push(...page.nodes);
      if (!page.hasNextPage || page.endId === null) break;
      afterId = page.endId;
    }
    if (result[kind].length !== summary.counts[kind]) {
      throw new Error(`Canonical ${kind} count changed during view creation`);
    }
  }
  return result;
}

async function deriveItems(
  summary: CatalogueChangeSummary,
  changes: Readonly<Record<ChangeKind, readonly EventChangeNode[]>>,
): Promise<readonly DerivedItem[]> {
  const items: DerivedItem[] = [];
  const storedByKind = new Map<ChangeKind, readonly StoredChange[]>();
  for (const kind of CHANGE_KINDS) {
    storedByKind.set(
      kind,
      await Promise.all(changes[kind].map((node) => encodeChange(kind, node))),
    );
  }

  const globalPageCounts = addDetailPages(
    items,
    null,
    summary.hash,
    storedByKind,
  );
  items.push(derivedItem(
    catalogueKey(null, summary.observation.date),
    encodeHeader(summary, changes, globalPageCounts),
  ));

  const countries = new Map<
    number,
    Record<ChangeKind, Array<{ node: EventChangeNode; stored: StoredChange }>>
  >();
  for (const kind of CHANGE_KINDS) {
    const nodes = changes[kind];
    const stored = storedByKind.get(kind)!;
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index]!;
      const codes = new Set<number>();
      if (node.before !== null) codes.add(node.before.countryCode);
      if (node.after !== null) codes.add(node.after.countryCode);
      for (const countryCode of codes) {
        const grouped = countries.get(countryCode) ?? {
          appeared: [],
          disappeared: [],
          updated: [],
        };
        grouped[kind].push({ node, stored: stored[index]! });
        countries.set(countryCode, grouped);
      }
    }
  }
  for (const [countryCode, grouped] of countries) {
    const countryStored: Record<ChangeKind, readonly StoredChange[]> = {
      appeared: grouped.appeared.map((entry) => entry.stored),
      disappeared: grouped.disappeared.map((entry) => entry.stored),
      updated: grouped.updated.map((entry) => entry.stored),
    };
    const pageCounts = addDetailPages(
      items,
      countryCode,
      summary.hash,
      new Map(Object.entries(countryStored) as [ChangeKind, StoredChange[]][]),
    );
    const countryChanges: Record<ChangeKind, readonly EventChangeNode[]> = {
      appeared: grouped.appeared.map((entry) => entry.node),
      disappeared: grouped.disappeared.map((entry) => entry.node),
      updated: grouped.updated.map((entry) => entry.node),
    };
    items.push(derivedItem(
      catalogueKey(countryCode, summary.observation.date),
      encodeHeader(summary, countryChanges, pageCounts),
    ));
  }

  const seenEvents = new Set<number>();
  for (const kind of CHANGE_KINDS) {
    const nodes = changes[kind];
    const stored = storedByKind.get(kind)!;
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index]!;
      if (seenEvents.has(node.id)) {
        throw new Error(`Event ${node.id} occurs twice in one change set`);
      }
      seenEvents.add(node.id);
      items.push(derivedItem(
        eventKey(node.id, summary.observation.date),
        {
          v: 1,
          h: summary.hash,
          o: encodeObservation(summary.observation),
          p: encodeObservation(summary.previousObservation),
          a: summary.confirmedAnomaly,
          n: stored[index]!,
        } satisfies StoredEventOccurrence,
      ));
    }
  }
  return items;
}

function addDetailPages(
  items: DerivedItem[],
  countryCode: number | null,
  hash: string,
  storedByKind: ReadonlyMap<ChangeKind, readonly StoredChange[]>,
): Readonly<Record<ChangeKind, number>> {
  const counts: Record<ChangeKind, number> = {
    appeared: 0,
    disappeared: 0,
    updated: 0,
  };
  for (const kind of CHANGE_KINDS) {
    const pages = packDetailPages(hash, kind, storedByKind.get(kind) ?? []);
    counts[kind] = pages.length;
    pages.forEach((page, index) => {
      items.push(derivedItem(detailKey(countryCode, hash, kind, index), page));
    });
  }
  return counts;
}

function packDetailPages(
  hash: string,
  kind: ChangeKind,
  nodes: readonly StoredChange[],
): StoredDetailPage[] {
  const pages: StoredDetailPage[] = [];
  let current: StoredChange[] = [];
  for (const node of nodes) {
    const candidate = detailPage(hash, kind, pages.length, [...current, node]);
    if (
      current.length > 0 &&
      encodedBytes(JSON.stringify(candidate)) > PAGE_TARGET_BYTES
    ) {
      pages.push(detailPage(hash, kind, pages.length, current));
      current = [node];
    } else {
      current.push(node);
    }
    assertSafeValue(
      JSON.stringify(detailPage(hash, kind, pages.length, current)),
    );
  }
  if (current.length > 0) {
    pages.push(detailPage(hash, kind, pages.length, current));
  }
  return pages;
}

function detailPage(
  hash: string,
  kind: ChangeKind,
  page: number,
  nodes: readonly StoredChange[],
): StoredDetailPage {
  return { v: 1, h: hash, k: CHANGE_KINDS.indexOf(kind), p: page, n: nodes };
}

function encodeHeader(
  summary: CatalogueChangeSummary,
  changes: Readonly<Record<ChangeKind, readonly EventChangeNode[]>>,
  pageCounts: Readonly<Record<ChangeKind, number>>,
): StoredCatalogueHeader {
  return {
    v: 1,
    h: summary.hash,
    o: encodeObservation(summary.observation),
    p: encodeObservation(summary.previousObservation),
    c: CHANGE_KINDS.map((kind) => changes[kind].length) as [
      number,
      number,
      number,
    ],
    q: CHANGE_KINDS.map((kind) => pageCounts[kind]) as [
      number,
      number,
      number,
    ],
    a: summary.confirmedAnomaly,
  };
}

async function encodeChange(
  kind: ChangeKind,
  node: EventChangeNode,
): Promise<StoredChange> {
  const beforeHash = node.before === null
    ? null
    : await sha256Hex(canonicalEventJson(node.before));
  const afterHash = node.after === null
    ? null
    : await sha256Hex(canonicalEventJson(node.after));
  return [
    CHANGE_KINDS.indexOf(kind),
    node.id,
    beforeHash,
    afterHash,
    encodeFieldMask(node.changedFields),
    node.before === null ? null : encodeEvent(node.before),
    node.after === null ? null : encodeEvent(node.after),
  ];
}

function encodeEvent(event: EventRecord): StoredEvent {
  return [
    event.id,
    event.slug,
    event.name,
    event.shortName,
    event.localisedName,
    event.location,
    event.latitude,
    event.longitude,
    event.countryCode,
    event.countryUrl,
    event.seriesId,
  ];
}

function encodeObservation(observation: PublicObservation): StoredObservation {
  return [observation.date, observation.fetchedAt];
}

function encodeFieldMask(fields: readonly EventField[]): number {
  let mask = 0;
  for (const field of fields) {
    const index = EVENT_FIELDS.indexOf(field);
    if (index < 0) throw new Error(`Unknown changed field ${field}`);
    mask |= 1 << index;
  }
  return mask;
}

function decodeHeader(
  value: unknown,
  date: string,
  countryCode: number | null,
): ViewCatalogueChangeSummary {
  const record = recordValue(value, "catalogue change view");
  if (
    record.v !== 1 || typeof record.h !== "string" ||
    !Array.isArray(record.o) || !Array.isArray(record.p) ||
    !Array.isArray(record.c) || !Array.isArray(record.q) ||
    typeof record.a !== "boolean"
  ) {
    throw new Error("Catalogue change view is invalid");
  }
  validateHash(record.h);
  const observation = decodeObservation(record.o, "observation");
  const previousObservation = decodeObservation(
    record.p,
    "previous observation",
  );
  if (observation.date !== date || previousObservation.date >= date) {
    throw new Error("Catalogue change view has inconsistent dates");
  }
  const counts = decodeKindCounts(record.c, "change counts");
  const pageCounts = decodeKindCounts(record.q, "detail page counts");
  return {
    hash: record.h,
    observation,
    previousObservation,
    counts,
    confirmedAnomaly: record.a,
    viewCountryCode: countryCode,
    viewPageCounts: pageCounts,
  };
}

async function decodeDetailPage(
  value: unknown,
  expectedHash: string,
  expectedKind: ChangeKind,
  expectedPage: number,
): Promise<readonly EventChangeNode[]> {
  const record = recordValue(value, "change detail page");
  if (
    record.v !== 1 || record.h !== expectedHash ||
    record.k !== CHANGE_KINDS.indexOf(expectedKind) ||
    record.p !== expectedPage || !Array.isArray(record.n)
  ) {
    throw new Error("Change detail page is invalid");
  }
  const nodes = await Promise.all(
    record.n.map((node) => decodeChange(node, expectedKind)),
  );
  for (let index = 1; index < nodes.length; index += 1) {
    if (nodes[index - 1]!.id >= nodes[index]!.id) {
      throw new Error("Change detail page is not ordered by event ID");
    }
  }
  return nodes;
}

async function decodeEventOccurrence(
  value: unknown,
  date: string,
  eventId: number,
): Promise<EventHistoryNode> {
  const record = recordValue(value, "event change view");
  if (
    record.v !== 1 || typeof record.h !== "string" ||
    !Array.isArray(record.o) || !Array.isArray(record.p) ||
    typeof record.a !== "boolean"
  ) {
    throw new Error("Event change view is invalid");
  }
  validateHash(record.h);
  const kindValue = Array.isArray(record.n) ? record.n[0] : undefined;
  const kind = typeof kindValue === "number"
    ? CHANGE_KINDS[kindValue]
    : undefined;
  if (kind === undefined) throw new Error("Event change kind is invalid");
  const change = await decodeChange(record.n, kind);
  const observation = decodeObservation(record.o, "observation");
  const previousObservation = decodeObservation(
    record.p,
    "previous observation",
  );
  if (
    observation.date !== date || previousObservation.date >= date ||
    change.id !== eventId
  ) {
    throw new Error("Event change view has inconsistent identity");
  }
  return {
    kind,
    observation,
    previousObservation,
    before: change.before,
    after: change.after,
    changedFields: change.changedFields,
    confirmedAnomaly: record.a,
  };
}

async function decodeChange(
  value: unknown,
  expectedKind: ChangeKind,
): Promise<EventChangeNode> {
  if (!Array.isArray(value) || value.length !== 7) {
    throw new Error("Stored materialized change is invalid");
  }
  const [
    kindIndex,
    id,
    beforeHash,
    afterHash,
    fieldMask,
    beforeValue,
    afterValue,
  ] = value;
  if (
    kindIndex !== CHANGE_KINDS.indexOf(expectedKind) ||
    !Number.isSafeInteger(id) || (id as number) < 1 ||
    (beforeHash !== null && typeof beforeHash !== "string") ||
    (afterHash !== null && typeof afterHash !== "string") ||
    !Number.isSafeInteger(fieldMask) || (fieldMask as number) < 0
  ) {
    throw new Error("Stored materialized change has invalid metadata");
  }
  if (beforeHash !== null) validateHash(beforeHash as string);
  if (afterHash !== null) validateHash(afterHash as string);
  const before = beforeValue === null ? null : decodeEvent(beforeValue);
  const after = afterValue === null ? null : decodeEvent(afterValue);
  if (
    (beforeHash === null) !== (before === null) ||
    (afterHash === null) !== (after === null) ||
    (before !== null && before.id !== id) || (after !== null && after.id !== id)
  ) {
    throw new Error("Stored materialized change has inconsistent events");
  }
  if (
    before !== null &&
    await sha256Hex(canonicalEventJson(before)) !== beforeHash
  ) {
    throw new Error("Stored before-event hash is invalid");
  }
  if (
    after !== null && await sha256Hex(canonicalEventJson(after)) !== afterHash
  ) {
    throw new Error("Stored after-event hash is invalid");
  }
  return {
    id: id as number,
    before,
    after,
    changedFields: decodeFieldMask(fieldMask as number),
  };
}

function decodeEvent(value: unknown): EventRecord {
  if (!Array.isArray(value) || value.length !== 11) {
    throw new Error("Stored event tuple is invalid");
  }
  const [
    id,
    slug,
    name,
    shortName,
    localisedName,
    location,
    latitude,
    longitude,
    countryCode,
    countryUrl,
    seriesId,
  ] = value;
  if (
    !Number.isSafeInteger(id) || (id as number) < 1 ||
    typeof slug !== "string" || typeof name !== "string" ||
    typeof shortName !== "string" ||
    (localisedName !== null && typeof localisedName !== "string") ||
    typeof location !== "string" || typeof latitude !== "number" ||
    !Number.isFinite(latitude) || typeof longitude !== "number" ||
    !Number.isFinite(longitude) || !Number.isSafeInteger(countryCode) ||
    typeof countryUrl !== "string" || !Number.isSafeInteger(seriesId)
  ) {
    throw new Error("Stored event tuple has invalid fields");
  }
  return {
    id: id as number,
    slug,
    name,
    shortName,
    localisedName,
    location,
    latitude,
    longitude,
    countryCode: countryCode as number,
    countryUrl,
    seriesId: seriesId as number,
  };
}

function decodeObservation(value: unknown[], label: string): PublicObservation {
  if (
    value.length !== 2 || typeof value[0] !== "string" ||
    typeof value[1] !== "string"
  ) {
    throw new Error(`Stored ${label} is invalid`);
  }
  parseUtcDate(value[0]);
  if (Number.isNaN(Date.parse(value[1]))) {
    throw new Error(`Stored ${label} timestamp is invalid`);
  }
  return { date: value[0], fetchedAt: value[1] };
}

function decodeKindCounts(
  value: unknown[],
  label: string,
): Readonly<Record<ChangeKind, number>> {
  if (
    value.length !== 3 ||
    value.some((count) =>
      !Number.isSafeInteger(count) || (count as number) < 0 ||
      (count as number) > MAX_CHANGE_COUNT
    )
  ) {
    throw new Error(`Stored ${label} are invalid`);
  }
  return {
    appeared: value[0] as number,
    disappeared: value[1] as number,
    updated: value[2] as number,
  };
}

function decodeFieldMask(mask: number): readonly EventField[] {
  if (mask >= 1 << EVENT_FIELDS.length) {
    throw new Error("Stored changed-field mask is invalid");
  }
  return EVENT_FIELDS.filter((_field, index) => (mask & 1 << index) !== 0);
}

function derivedItem(key: Deno.KvKey, value: unknown): DerivedItem {
  const encoded = JSON.stringify(value);
  assertSafeValue(encoded);
  return { key, value, encoded };
}

function cataloguePrefix(countryCode: number | null): Deno.KvKey {
  return countryCode === null
    ? [...VIEW_PREFIX, "catalogue", "all"]
    : [...VIEW_PREFIX, "catalogue", "country", countryCode];
}

function catalogueKey(countryCode: number | null, date: string): Deno.KvKey {
  return [...cataloguePrefix(countryCode), date];
}

function detailKey(
  countryCode: number | null,
  hash: string,
  kind: ChangeKind,
  page: number,
): Deno.KvKey {
  return countryCode === null
    ? [...VIEW_PREFIX, "detail", "all", hash, kind, page]
    : [...VIEW_PREFIX, "detail", "country", countryCode, hash, kind, page];
}

function eventPrefix(eventId: number): Deno.KvKey {
  return [...VIEW_PREFIX, "event", eventId];
}

function eventKey(eventId: number, date: string): Deno.KvKey {
  return [...eventPrefix(eventId), date];
}

function validateCountryCode(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > GRAPHQL_INT_MAX) {
    throw new RangeError("Country code must be a non-negative GraphQL integer");
  }
  return value;
}

function validatePageSize(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new RangeError(`${label} page size must be between 1 and 100`);
  }
}

function validateHash(value: string): void {
  if (!HASH_PATTERN.test(value)) throw new Error("Stored hash is invalid");
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Stored ${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function assertSafeValue(encoded: string): void {
  const bytes = encodedBytes(encoded);
  if (bytes > MAX_SAFE_VALUE_BYTES) {
    throw new Error(
      `Materialized change value is ${bytes} bytes; maximum is ${MAX_SAFE_VALUE_BYTES}`,
    );
  }
}

function encodedBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function countChanges(
  changes: Readonly<Record<ChangeKind, readonly EventChangeNode[]>>,
): number {
  return CHANGE_KINDS.reduce((total, kind) => total + changes[kind].length, 0);
}
