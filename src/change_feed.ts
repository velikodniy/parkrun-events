import type {
  CatalogueChangePage,
  CatalogueChangeSummary,
  ChangeKind,
  EventChangeNode,
  EventChangePage,
  PublicObservation,
} from "./archive.ts";
import type { ChangeReadModel } from "./change_views.ts";
import { parseUtcDate } from "./date.ts";
import type { EventField, EventRecord } from "./model.ts";
import { sha256Hex } from "./model.ts";

const FEED_PREFIX = ["parkrun-events", "read-v3"] as const;
const WATERMARK_KEY = [...FEED_PREFIX, "meta", "watermark"] as const;
const ENVELOPE_MAGIC = new TextEncoder().encode("PCF1");
const ENVELOPE_HEADER_BYTES = 40;
const READ_UNIT_TARGET_BYTES = 3_500;
const MAX_VALUE_BYTES = 48 * 1024;
const MAX_UNCOMPRESSED_BYTES = 64 * 1024;
const FRAGMENT_TARGET_BYTES = 30 * 1024;
const MAX_BATCH_KEYS = 10;
const MAX_CHANGE_COUNT = 100_000;
const GRAPHQL_INT_MAX = 2_147_483_647;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
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
type StoredNode = readonly [
  id: number,
  before: StoredEvent | null,
  after: StoredEvent | null,
  changedFieldMask: number,
];
type StoredFragment = readonly [
  observation: StoredObservation,
  previousObservation: StoredObservation,
  changeSetHash: string,
  confirmedAnomaly: boolean,
  fragment: number,
  lastFragment: boolean,
  appeared: readonly StoredNode[],
  disappeared: readonly StoredNode[],
  updated: readonly StoredNode[],
];

interface StoredPayload {
  readonly v: 1;
  readonly s: string;
  readonly m: string;
  readonly f: readonly StoredFragment[];
}

interface StoredDirectory {
  readonly v: "change-feed-directory-v1";
  readonly g: string;
  readonly p: number;
}

interface StoredWatermark {
  readonly v: 1;
  readonly d: string;
}

interface FeedDate {
  readonly hash: string;
  readonly observation: PublicObservation;
  readonly previousObservation: PublicObservation;
  readonly confirmedAnomaly: boolean;
  readonly changes: Readonly<Record<ChangeKind, readonly EventChangeNode[]>>;
}

interface MonthEntry {
  readonly entry: Deno.KvEntryMaybe<unknown>;
  readonly dates: readonly FeedDate[];
}

interface MonthPlan {
  readonly value: Uint8Array | StoredDirectory;
  readonly pages: readonly Uint8Array[];
  readonly generation: string | null;
  readonly bytes: number;
}

export interface FeedCatalogueChangeSummary extends CatalogueChangeSummary {
  readonly feedCountryCode: number | null;
  readonly feedChanges: Readonly<
    Record<ChangeKind, readonly EventChangeNode[]>
  >;
}

export interface FeedCatalogueChangePage extends CatalogueChangePage {
  readonly nodes: readonly FeedCatalogueChangeSummary[];
  readonly resumeMonth: string | null;
}

export interface ChangeFeedSyncProgress {
  readonly position: number;
  readonly date: string;
  readonly changeCount: number;
  readonly applied: boolean;
}

export interface ChangeFeedSyncReport {
  readonly throughDate: string | null;
  readonly changeDates: number;
  readonly changedEvents: number;
  readonly monthScopes: number;
  readonly records: number;
  readonly bytes: number;
  readonly applied: boolean;
}

export class ChangeFeedNotReadyError extends Error {
  constructor() {
    super("The packed change feed is not ready");
    this.name = "ChangeFeedNotReadyError";
  }
}

export class ChangeFeed {
  constructor(private readonly kv: Deno.Kv) {}

  async synchronize(
    views: ChangeReadModel,
    options: {
      readonly apply: boolean;
      readonly fromBeginning?: boolean;
      readonly publish?: boolean;
      readonly onProgress?: (progress: ChangeFeedSyncProgress) => void;
    },
  ): Promise<ChangeFeedSyncReport> {
    const targetDate = await views.getWatermark();
    const watermark = await this.readWatermarkEntry();
    if (
      targetDate !== null && watermark.value !== null &&
      watermark.value.d > targetDate
    ) {
      throw new Error("Change-feed watermark is ahead of the change views");
    }
    const startDate = options.fromBeginning ? null : watermark.value?.d ?? null;
    let afterDate = startDate;
    let changeDates = 0;
    let changedEvents = 0;
    const additions = new Map<string, {
      readonly countryCode: number | null;
      readonly month: string;
      readonly dates: FeedDate[];
    }>();

    while (targetDate !== null) {
      const page = await views.listCatalogueChanges({
        first: 100,
        through: targetDate,
        ...(afterDate === null ? {} : { afterDate }),
      });
      for (const summary of page.nodes) {
        const changes = await views.getAllEventChanges(summary);
        const date = feedDate(summary, changes);
        addMonthDate(additions, null, date);
        for (const [countryCode, countryChanges] of groupByCountry(changes)) {
          addMonthDate(
            additions,
            countryCode,
            feedDate(summary, countryChanges),
          );
        }
        changeDates += 1;
        const changeCount = countChanges(changes);
        changedEvents += changeCount;
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

    let records = 0;
    let bytes = 0;
    for (const group of additions.values()) {
      const result = options.apply
        ? await this.appendMonthDates(
          group.countryCode,
          group.month,
          group.dates,
        )
        : await planMonth(group.countryCode, group.month, group.dates);
      records += 1 + result.pages.length;
      bytes += result.bytes;
    }
    if (options.apply && options.publish !== false && targetDate !== null) {
      await this.advanceWatermark(targetDate);
    }
    return {
      throughDate: targetDate,
      changeDates,
      changedEvents,
      monthScopes: additions.size,
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
    readonly startMonth?: string;
  }): Promise<FeedCatalogueChangePage> {
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
      return {
        nodes: [],
        endDate: null,
        hasNextPage: false,
        resumeMonth: null,
      };
    }
    const startMonth = options.startMonth ??
      (afterDate ?? from)?.slice(0, 7) ?? null;
    if (startMonth !== null && !MONTH_PATTERN.test(startMonth)) {
      throw new RangeError("Change-feed resume month is invalid");
    }
    const prefix = monthPrefix(countryCode);
    const selector: Deno.KvListSelector = startMonth === null
      ? { prefix, end: [...prefix, nextMonth(effectiveThrough.slice(0, 7))] }
      : {
        start: [...prefix, startMonth],
        end: [...prefix, nextMonth(effectiveThrough.slice(0, 7))],
      };
    const rows: FeedCatalogueChangeSummary[] = [];
    const iterator = this.kv.list<unknown>(selector, {
      batchSize: 1,
      consistency: "strong",
    });
    outer:
    for await (const entry of iterator) {
      const month = entry.key.at(-1);
      if (typeof month !== "string" || !MONTH_PATTERN.test(month)) {
        throw new Error("Packed change-feed month key is invalid");
      }
      const dates = await this.decodeMonthValue(
        countryCode,
        month,
        entry.value,
      );
      for (const date of dates) {
        if (
          date.observation.date > effectiveThrough ||
          (from !== null && date.observation.date < from) ||
          (afterDate !== null && date.observation.date <= afterDate)
        ) {
          continue;
        }
        rows.push(toSummary(date, countryCode));
        if (rows.length > options.first) break outer;
      }
    }
    const hasNextPage = rows.length > options.first;
    const nodes = rows.slice(0, options.first);
    return {
      nodes,
      endDate: nodes.at(-1)?.observation.date ?? null,
      hasNextPage,
      resumeMonth: hasNextPage
        ? rows[options.first]!.observation.date.slice(0, 7)
        : nodes.at(-1)?.observation.date.slice(0, 7) ?? null,
    };
  }

  getEventChanges(
    summary: FeedCatalogueChangeSummary,
    kind: ChangeKind,
    options: { readonly first: number; readonly afterId?: number },
  ): EventChangePage {
    validatePageSize(options.first, "Event-change");
    const changes = summary.feedChanges[kind];
    const start = options.afterId === undefined
      ? 0
      : changes.findIndex((change) => change.id > options.afterId!);
    if (start < 0) {
      return { nodes: [], endId: null, hasNextPage: false };
    }
    const selected = changes.slice(start, start + options.first + 1);
    const nodes = selected.slice(0, options.first);
    return {
      nodes,
      endId: nodes.at(-1)?.id ?? null,
      hasNextPage: selected.length > options.first,
    };
  }

  async getWatermark(): Promise<string | null> {
    return (await this.readWatermarkEntry()).value?.d ?? null;
  }

  private async appendMonthDates(
    countryCode: number | null,
    month: string,
    additions: readonly FeedDate[],
    attempt = 0,
  ): Promise<MonthPlan> {
    const current = await this.readMonth(countryCode, month);
    const merged = mergeDates(current.dates, additions);
    if (merged === current.dates) {
      return await planMonth(countryCode, month, merged);
    }
    const plan = await planMonth(countryCode, month, merged);
    if (plan.generation !== null) {
      await this.putPages(
        countryCode,
        month,
        plan.generation,
        plan.pages,
      );
    }
    const result = await this.kv.atomic()
      .check(current.entry)
      .set(monthKey(countryCode, month), plan.value)
      .commit();
    if (result.ok) return plan;
    if (attempt >= 2) {
      throw new Error("Could not update packed change-feed month");
    }
    return await this.appendMonthDates(
      countryCode,
      month,
      additions,
      attempt + 1,
    );
  }

  private async readMonth(
    countryCode: number | null,
    month: string,
  ): Promise<MonthEntry> {
    const entry = await this.kv.get<unknown>(monthKey(countryCode, month), {
      consistency: "strong",
    });
    return {
      entry,
      dates: entry.value === null
        ? []
        : await this.decodeMonthValue(countryCode, month, entry.value),
    };
  }

  private async decodeMonthValue(
    countryCode: number | null,
    month: string,
    value: unknown,
  ): Promise<readonly FeedDate[]> {
    if (value instanceof Uint8Array) {
      return fragmentsToDates(
        (await decodeEnvelope(value, scopeId(countryCode), month)).f,
      );
    }
    const directory = decodeDirectory(value);
    const keys = Array.from(
      { length: directory.p },
      (_, page) => pageKey(countryCode, month, directory.g, page),
    );
    const fragments: StoredFragment[] = [];
    for (let offset = 0; offset < keys.length; offset += MAX_BATCH_KEYS) {
      const chunk = keys.slice(offset, offset + MAX_BATCH_KEYS);
      const entries = await this.kv.getMany(
        chunk as [Deno.KvKey, ...Deno.KvKey[]],
        { consistency: "strong" },
      );
      for (let index = 0; index < entries.length; index += 1) {
        const page = entries[index]!.value;
        if (!(page instanceof Uint8Array)) {
          throw new Error(`Missing packed change-feed page ${offset + index}`);
        }
        fragments.push(
          ...(await decodeEnvelope(page, scopeId(countryCode), month)).f,
        );
      }
    }
    const dates = fragmentsToDates(fragments);
    if (
      await generationHash(scopeId(countryCode), month, fragments) !==
        directory.g
    ) {
      throw new Error("Packed change-feed generation hash is invalid");
    }
    return dates;
  }

  private async putPages(
    countryCode: number | null,
    month: string,
    generation: string,
    pages: readonly Uint8Array[],
  ): Promise<void> {
    for (let offset = 0; offset < pages.length; offset += MAX_BATCH_KEYS) {
      const chunk = pages.slice(offset, offset + MAX_BATCH_KEYS);
      const keys = chunk.map((_, index) =>
        pageKey(countryCode, month, generation, offset + index)
      );
      await this.putPageChunk(keys, chunk, 0);
    }
  }

  private async putPageChunk(
    keys: readonly Deno.KvKey[],
    pages: readonly Uint8Array[],
    attempt: number,
  ): Promise<void> {
    const entries = await this.kv.getMany(
      keys as [Deno.KvKey, ...Deno.KvKey[]],
      { consistency: "strong" },
    );
    let atomic = this.kv.atomic();
    let mutations = 0;
    for (let index = 0; index < pages.length; index += 1) {
      const existing = entries[index]!;
      const page = pages[index]!;
      if (existing.value !== null) {
        if (
          !(existing.value instanceof Uint8Array) ||
          !equalBytes(existing.value, page)
        ) {
          throw new Error("Packed change-feed page conflicts");
        }
        continue;
      }
      atomic = atomic.check(existing).set(keys[index]!, page);
      mutations += 1;
    }
    if (mutations === 0) return;
    const result = await atomic.commit();
    if (result.ok) return;
    if (attempt >= 2) {
      throw new Error("Could not stage packed change-feed pages");
    }
    await this.putPageChunk(keys, pages, attempt + 1);
  }

  private async requireWatermark(): Promise<string> {
    const watermark = await this.getWatermark();
    if (watermark === null) throw new ChangeFeedNotReadyError();
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
    const value = recordValue(entry.value, "change-feed watermark");
    if (value.v !== 1 || typeof value.d !== "string") {
      throw new Error("Packed change-feed watermark is invalid");
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
    throw new Error("Could not advance packed change-feed watermark");
  }
}

function feedDate(
  summary: CatalogueChangeSummary,
  changes: Readonly<Record<ChangeKind, readonly EventChangeNode[]>>,
): FeedDate {
  return {
    hash: summary.hash,
    observation: summary.observation,
    previousObservation: summary.previousObservation,
    confirmedAnomaly: summary.confirmedAnomaly,
    changes,
  };
}

function addMonthDate(
  groups: Map<string, {
    readonly countryCode: number | null;
    readonly month: string;
    readonly dates: FeedDate[];
  }>,
  countryCode: number | null,
  date: FeedDate,
): void {
  const month = date.observation.date.slice(0, 7);
  const key = `${countryCode ?? "all"}:${month}`;
  const group = groups.get(key) ?? { countryCode, month, dates: [] };
  group.dates.push(date);
  groups.set(key, group);
}

function groupByCountry(
  changes: Readonly<Record<ChangeKind, readonly EventChangeNode[]>>,
): ReadonlyMap<
  number,
  Readonly<Record<ChangeKind, readonly EventChangeNode[]>>
> {
  const result = new Map<number, Record<ChangeKind, EventChangeNode[]>>();
  for (const kind of CHANGE_KINDS) {
    for (const node of changes[kind]) {
      const countries = new Set<number>();
      if (node.before !== null) countries.add(node.before.countryCode);
      if (node.after !== null) countries.add(node.after.countryCode);
      for (const countryCode of countries) {
        const grouped = result.get(countryCode) ?? {
          appeared: [],
          disappeared: [],
          updated: [],
        };
        grouped[kind].push(node);
        result.set(countryCode, grouped);
      }
    }
  }
  return result;
}

async function planMonth(
  countryCode: number | null,
  month: string,
  dates: readonly FeedDate[],
): Promise<MonthPlan> {
  validateMonthDates(month, dates);
  const scope = scopeId(countryCode);
  const fragments: StoredFragment[] = [];
  for (const date of dates) {
    fragments.push(...await splitDate(scope, month, date));
  }
  const inline = await tryEnvelope({ v: 1, s: scope, m: month, f: fragments });
  if (inline !== null && inline.byteLength <= READ_UNIT_TARGET_BYTES) {
    return {
      value: inline,
      pages: [],
      generation: null,
      bytes: inline.byteLength,
    };
  }
  const pages = await packPages(scope, month, fragments);
  const generation = await generationHash(scope, month, fragments);
  const value: StoredDirectory = {
    v: "change-feed-directory-v1",
    g: generation,
    p: pages.length,
  };
  return {
    value,
    pages,
    generation,
    bytes: encodedBytes(JSON.stringify(value)) + pages.reduce(
      (total, page) => total + page.byteLength,
      0,
    ),
  };
}

async function splitDate(
  scope: string,
  month: string,
  date: FeedDate,
): Promise<StoredFragment[]> {
  const changes: Array<readonly [ChangeKind, StoredNode]> = [];
  for (const kind of CHANGE_KINDS) {
    for (const node of date.changes[kind]) {
      changes.push([kind, encodeNode(node)]);
    }
  }
  const rawChunks: Array<Array<readonly [ChangeKind, StoredNode]>> = [];
  let current: Array<readonly [ChangeKind, StoredNode]> = [];
  for (const change of changes) {
    const candidate = [...current, change];
    if (
      current.length > 0 &&
      encodedBytes(JSON.stringify(candidate)) > FRAGMENT_TARGET_BYTES
    ) {
      rawChunks.push(current);
      current = [change];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) rawChunks.push(current);

  const chunks: Array<Array<readonly [ChangeKind, StoredNode]>> = [];
  for (const chunk of rawChunks) {
    chunks.push(...await splitChunkForReadUnit(scope, month, date, chunk));
  }
  return chunks.map((chunk, index) =>
    fragmentFromChanges(date, chunk, index, index === chunks.length - 1)
  );
}

async function splitChunkForReadUnit(
  scope: string,
  month: string,
  date: FeedDate,
  changes: Array<readonly [ChangeKind, StoredNode]>,
): Promise<Array<Array<readonly [ChangeKind, StoredNode]>>> {
  const fragment = fragmentFromChanges(date, changes, 0, true);
  const encoded = await tryEnvelope({
    v: 1,
    s: scope,
    m: month,
    f: [fragment],
  });
  if (
    changes.length <= 1 ||
    (encoded !== null && encoded.byteLength <= READ_UNIT_TARGET_BYTES)
  ) {
    return [changes];
  }
  const middle = Math.ceil(changes.length / 2);
  return [
    ...await splitChunkForReadUnit(
      scope,
      month,
      date,
      changes.slice(0, middle),
    ),
    ...await splitChunkForReadUnit(
      scope,
      month,
      date,
      changes.slice(middle),
    ),
  ];
}

function fragmentFromChanges(
  date: FeedDate,
  changes: readonly (readonly [ChangeKind, StoredNode])[],
  index: number,
  last: boolean,
): StoredFragment {
  const byKind: Record<ChangeKind, StoredNode[]> = {
    appeared: [],
    disappeared: [],
    updated: [],
  };
  for (const [kind, node] of changes) byKind[kind].push(node);
  return [
    encodeObservation(date.observation),
    encodeObservation(date.previousObservation),
    date.hash,
    date.confirmedAnomaly,
    index,
    last,
    byKind.appeared,
    byKind.disappeared,
    byKind.updated,
  ];
}

async function packPages(
  scope: string,
  month: string,
  fragments: readonly StoredFragment[],
): Promise<readonly Uint8Array[]> {
  const pages: Uint8Array[] = [];
  let current: StoredFragment[] = [];
  for (const fragment of fragments) {
    const candidate = await tryEnvelope({
      v: 1,
      s: scope,
      m: month,
      f: [...current, fragment],
    });
    if (
      current.length > 0 &&
      (candidate === null || candidate.byteLength > READ_UNIT_TARGET_BYTES)
    ) {
      const page = await encodeEnvelope({
        v: 1,
        s: scope,
        m: month,
        f: current,
      });
      pages.push(page);
      current = [fragment];
    } else {
      current.push(fragment);
    }
    const single = await encodeEnvelope({
      v: 1,
      s: scope,
      m: month,
      f: current,
    });
    if (single.byteLength > MAX_VALUE_BYTES) {
      throw new Error("One packed change-feed fragment exceeds 48 KiB");
    }
  }
  if (current.length > 0) {
    pages.push(
      await encodeEnvelope({
        v: 1,
        s: scope,
        m: month,
        f: current,
      }),
    );
  }
  return pages;
}

async function tryEnvelope(payload: StoredPayload): Promise<Uint8Array | null> {
  const raw = new TextEncoder().encode(JSON.stringify(payload));
  if (raw.byteLength > MAX_UNCOMPRESSED_BYTES) return null;
  const encoded = await envelope(raw);
  return encoded.byteLength <= MAX_VALUE_BYTES ? encoded : null;
}

async function encodeEnvelope(payload: StoredPayload): Promise<Uint8Array> {
  const encoded = await tryEnvelope(payload);
  if (encoded === null) {
    throw new Error("Packed change-feed page exceeds decompression ceiling");
  }
  return encoded;
}

async function envelope(raw: Uint8Array): Promise<Uint8Array> {
  const compressed = await gzip(raw);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", ownedBytes(raw)),
  );
  const result = new Uint8Array(
    ENVELOPE_HEADER_BYTES + compressed.byteLength,
  );
  result.set(ENVELOPE_MAGIC, 0);
  new DataView(result.buffer).setUint32(4, raw.byteLength);
  result.set(digest, 8);
  result.set(compressed, ENVELOPE_HEADER_BYTES);
  return result;
}

async function decodeEnvelope(
  value: Uint8Array,
  expectedScope: string,
  expectedMonth: string,
): Promise<StoredPayload> {
  if (
    value.byteLength <= ENVELOPE_HEADER_BYTES ||
    !equalBytes(value.subarray(0, 4), ENVELOPE_MAGIC)
  ) {
    throw new Error("Packed change-feed envelope is invalid");
  }
  const expectedLength = new DataView(
    value.buffer,
    value.byteOffset,
    value.byteLength,
  ).getUint32(4);
  if (expectedLength > MAX_UNCOMPRESSED_BYTES) {
    throw new Error("Packed change-feed envelope is too large");
  }
  const raw = await gunzipBounded(
    value.subarray(ENVELOPE_HEADER_BYTES),
    expectedLength,
  );
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", ownedBytes(raw)),
  );
  if (!equalBytes(digest, value.subarray(8, 40))) {
    throw new Error("Packed change-feed checksum is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new Error("Packed change-feed JSON is invalid");
  }
  const record = recordValue(parsed, "change-feed payload");
  if (
    record.v !== 1 || record.s !== expectedScope ||
    record.m !== expectedMonth ||
    !Array.isArray(record.f)
  ) {
    throw new Error("Packed change-feed payload is invalid");
  }
  return {
    v: 1,
    s: expectedScope,
    m: expectedMonth,
    f: record.f.map(decodeFragment),
  };
}

async function gzip(raw: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([ownedBytes(raw)]).stream().pipeThrough(
    new CompressionStream("gzip"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipBounded(
  compressed: Uint8Array,
  expectedLength: number,
): Promise<Uint8Array> {
  const reader = new Blob([ownedBytes(compressed)]).stream()
    .pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > expectedLength || length > MAX_UNCOMPRESSED_BYTES) {
        await reader.cancel("decompressed change feed exceeds its bound");
        throw new Error("Packed change-feed decompressed size is invalid");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (length !== expectedLength) {
    throw new Error("Packed change-feed decompressed length is invalid");
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function fragmentsToDates(fragments: readonly StoredFragment[]): FeedDate[] {
  const dates: FeedDate[] = [];
  let current: {
    header: readonly [StoredObservation, StoredObservation, string, boolean];
    nextFragment: number;
    changes: Record<ChangeKind, EventChangeNode[]>;
  } | null = null;
  for (const fragment of fragments) {
    const [observation, previous, hash, anomaly, index, last] = fragment;
    if (current === null) {
      if (index !== 0) throw new Error("Change-feed date starts mid-fragment");
      current = {
        header: [observation, previous, hash, anomaly],
        nextFragment: 0,
        changes: { appeared: [], disappeared: [], updated: [] },
      };
    }
    if (
      index !== current.nextFragment ||
      JSON.stringify(current.header) !==
        JSON.stringify([observation, previous, hash, anomaly])
    ) {
      throw new Error("Change-feed fragments are not contiguous");
    }
    current.changes.appeared.push(...fragment[6].map(decodeNode));
    current.changes.disappeared.push(...fragment[7].map(decodeNode));
    current.changes.updated.push(...fragment[8].map(decodeNode));
    current.nextFragment += 1;
    if (last) {
      const [storedObservation, storedPrevious, storedHash, storedAnomaly] =
        current.header;
      dates.push({
        hash: storedHash,
        observation: decodeObservation(storedObservation),
        previousObservation: decodeObservation(storedPrevious),
        confirmedAnomaly: storedAnomaly,
        changes: current.changes,
      });
      current = null;
    }
  }
  if (current !== null) throw new Error("Change-feed date is incomplete");
  validateDateOrder(dates);
  return dates;
}

function decodeFragment(value: unknown): StoredFragment {
  if (
    !Array.isArray(value) || value.length !== 9 ||
    !Array.isArray(value[0]) || !Array.isArray(value[1]) ||
    typeof value[2] !== "string" || typeof value[3] !== "boolean" ||
    !Number.isSafeInteger(value[4]) || (value[4] as number) < 0 ||
    typeof value[5] !== "boolean" || !Array.isArray(value[6]) ||
    !Array.isArray(value[7]) || !Array.isArray(value[8])
  ) {
    throw new Error("Stored change-feed fragment is invalid");
  }
  validateHash(value[2]);
  decodeObservation(value[0] as unknown as StoredObservation);
  decodeObservation(value[1] as unknown as StoredObservation);
  const arrays = [value[6], value[7], value[8]] as unknown[][];
  if (
    arrays.some((nodes) => nodes.length > MAX_CHANGE_COUNT) ||
    arrays.reduce((total, nodes) => total + nodes.length, 0) > MAX_CHANGE_COUNT
  ) {
    throw new Error("Stored change-feed fragment has too many changes");
  }
  arrays.forEach((nodes) => nodes.forEach(decodeStoredNodeShape));
  return value as unknown as StoredFragment;
}

function decodeStoredNodeShape(value: unknown): void {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error("Stored change-feed node is invalid");
  }
}

function encodeNode(node: EventChangeNode): StoredNode {
  return [
    node.id,
    node.before === null ? null : encodeEvent(node.before),
    node.after === null ? null : encodeEvent(node.after),
    encodeFieldMask(node.changedFields),
  ];
}

function decodeNode(value: StoredNode): EventChangeNode {
  const [id, beforeValue, afterValue, mask] = value;
  if (
    !Number.isSafeInteger(id) || id < 1 || id > GRAPHQL_INT_MAX ||
    !Number.isSafeInteger(mask) || mask < 0 || mask >= 1 << EVENT_FIELDS.length
  ) {
    throw new Error("Stored change-feed node metadata is invalid");
  }
  const before = beforeValue === null ? null : decodeEvent(beforeValue);
  const after = afterValue === null ? null : decodeEvent(afterValue);
  if (
    (before !== null && before.id !== id) ||
    (after !== null && after.id !== id) ||
    (before === null && after === null)
  ) {
    throw new Error("Stored change-feed node identity is invalid");
  }
  return {
    id,
    before,
    after,
    changedFields: EVENT_FIELDS.filter(
      (_field, index) => (mask & 1 << index) !== 0,
    ),
  };
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

function decodeEvent(value: StoredEvent): EventRecord {
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
    !Number.isSafeInteger(id) || id < 1 || id > GRAPHQL_INT_MAX ||
    typeof slug !== "string" || typeof name !== "string" ||
    typeof shortName !== "string" ||
    (localisedName !== null && typeof localisedName !== "string") ||
    typeof location !== "string" || !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) || !Number.isSafeInteger(countryCode) ||
    countryCode < 0 || typeof countryUrl !== "string" ||
    !Number.isSafeInteger(seriesId)
  ) {
    throw new Error("Stored change-feed event is invalid");
  }
  return {
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
  };
}

function encodeObservation(value: PublicObservation): StoredObservation {
  return [value.date, value.fetchedAt];
}

function decodeObservation(value: StoredObservation): PublicObservation {
  if (
    value.length !== 2 || typeof value[0] !== "string" ||
    typeof value[1] !== "string"
  ) {
    throw new Error("Stored change-feed observation is invalid");
  }
  parseUtcDate(value[0]);
  if (Number.isNaN(Date.parse(value[1]))) {
    throw new Error("Stored change-feed observation timestamp is invalid");
  }
  return { date: value[0], fetchedAt: value[1] };
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

function toSummary(
  date: FeedDate,
  countryCode: number | null,
): FeedCatalogueChangeSummary {
  return {
    hash: date.hash,
    observation: date.observation,
    previousObservation: date.previousObservation,
    counts: {
      appeared: date.changes.appeared.length,
      disappeared: date.changes.disappeared.length,
      updated: date.changes.updated.length,
    },
    confirmedAnomaly: date.confirmedAnomaly,
    feedCountryCode: countryCode,
    feedChanges: date.changes,
  };
}

function mergeDates(
  current: readonly FeedDate[],
  additions: readonly FeedDate[],
): readonly FeedDate[] {
  const result = [...current];
  let changed = false;
  for (const addition of [...additions].sort(compareDates)) {
    const existing = result.find((date) =>
      date.observation.date === addition.observation.date
    );
    if (existing !== undefined) {
      if (canonicalDate(existing) !== canonicalDate(addition)) {
        throw new Error(
          `Packed change-feed date ${addition.observation.date} conflicts`,
        );
      }
      continue;
    }
    if (
      result.length > 0 &&
      result.at(-1)!.observation.date >= addition.observation.date
    ) {
      throw new Error("Packed change-feed dates must append chronologically");
    }
    result.push(addition);
    changed = true;
  }
  return changed ? result : current;
}

function canonicalDate(date: FeedDate): string {
  return JSON.stringify([
    encodeObservation(date.observation),
    encodeObservation(date.previousObservation),
    date.hash,
    date.confirmedAnomaly,
    CHANGE_KINDS.map((kind) => date.changes[kind].map(encodeNode)),
  ]);
}

function validateMonthDates(month: string, dates: readonly FeedDate[]): void {
  if (!MONTH_PATTERN.test(month)) {
    throw new Error("Change-feed month is invalid");
  }
  validateDateOrder(dates);
  for (const date of dates) {
    if (date.observation.date.slice(0, 7) !== month) {
      throw new Error("Change-feed date is in the wrong month");
    }
    validateHash(date.hash);
    if (date.previousObservation.date >= date.observation.date) {
      throw new Error("Change-feed previous observation is invalid");
    }
    for (const kind of CHANGE_KINDS) {
      if (date.changes[kind].length > MAX_CHANGE_COUNT) {
        throw new Error("Change-feed date has too many changes");
      }
    }
  }
}

function validateDateOrder(dates: readonly FeedDate[]): void {
  for (let index = 1; index < dates.length; index += 1) {
    if (
      dates[index - 1]!.observation.date >= dates[index]!.observation.date
    ) {
      throw new Error("Change-feed dates are not chronological");
    }
  }
}

async function generationHash(
  scope: string,
  month: string,
  fragments: readonly StoredFragment[],
): Promise<string> {
  return await sha256Hex(JSON.stringify([
    "change-feed-generation-v1",
    scope,
    month,
    fragments,
  ]));
}

function decodeDirectory(value: unknown): StoredDirectory {
  const record = recordValue(value, "change-feed directory");
  if (
    record.v !== "change-feed-directory-v1" || typeof record.g !== "string" ||
    !Number.isSafeInteger(record.p) || (record.p as number) < 1 ||
    (record.p as number) > MAX_CHANGE_COUNT
  ) {
    throw new Error("Packed change-feed directory is invalid");
  }
  validateHash(record.g);
  return {
    v: "change-feed-directory-v1",
    g: record.g,
    p: record.p as number,
  };
}

function scopeId(countryCode: number | null): string {
  return countryCode === null ? "all" : `country:${countryCode}`;
}

function monthPrefix(countryCode: number | null): Deno.KvKey {
  return countryCode === null
    ? [...FEED_PREFIX, "feed", "all"]
    : [...FEED_PREFIX, "feed", "country", countryCode];
}

function monthKey(countryCode: number | null, month: string): Deno.KvKey {
  return [...monthPrefix(countryCode), month];
}

function pageKey(
  countryCode: number | null,
  month: string,
  generation: string,
  page: number,
): Deno.KvKey {
  return countryCode === null
    ? [...FEED_PREFIX, "page", "all", month, generation, page]
    : [
      ...FEED_PREFIX,
      "page",
      "country",
      countryCode,
      month,
      generation,
      page,
    ];
}

function nextMonth(month: string): string {
  if (!MONTH_PATTERN.test(month)) throw new Error("Month is invalid");
  const year = Number(month.slice(0, 4));
  const number = Number(month.slice(5, 7));
  if (number === 12) return `${String(year + 1).padStart(4, "0")}-01`;
  const next = String(number + 1).padStart(2, "0");
  return `${String(year).padStart(4, "0")}-${next}`;
}

function compareDates(left: FeedDate, right: FeedDate): number {
  return left.observation.date < right.observation.date
    ? -1
    : left.observation.date > right.observation.date
    ? 1
    : 0;
}

function countChanges(
  changes: Readonly<Record<ChangeKind, readonly EventChangeNode[]>>,
): number {
  return CHANGE_KINDS.reduce((total, kind) => total + changes[kind].length, 0);
}

function validatePageSize(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new RangeError(`${label} page size must be between 1 and 100`);
  }
}

function validateCountryCode(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > GRAPHQL_INT_MAX) {
    throw new RangeError("Country code must be a non-negative GraphQL integer");
  }
  return value;
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

function encodedBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(value.byteLength);
  result.set(value);
  return result;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index]);
}
