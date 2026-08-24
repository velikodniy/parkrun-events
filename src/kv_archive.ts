import type {
  ArchiveControl,
  ArchiveHead,
  ArchiveInfo,
  CatalogueChangePage,
  ChangeKind,
  ChangeReference,
  ChangeSetManifest,
  EventChangePage,
  EventLookupInput,
  EventLookupResult,
  ObservationRecord,
  PendingCandidate,
  PublicObservation,
  PublishObservationInput,
  StoredChangeSet,
} from "./archive.ts";
import { nextUtcDate, parseUtcDate } from "./date.ts";
import {
  bucketIndexForSlug,
  canonicalBucketJson,
  canonicalEventJson,
  canonicalRevisionJson,
  sha256Hex,
} from "./model.ts";
import type {
  BucketEntry,
  CatalogueDiff,
  CatalogueRevision,
  EventRecord,
  HashedEvent,
  RevisionBucket,
  RevisionManifest,
} from "./model.ts";

const PREFIX = ["parkrun-events", "v1"] as const;
const EVENT_PREFIX = [...PREFIX, "event"] as const;
const BUCKET_PREFIX = [...PREFIX, "bucket"] as const;
const REVISION_PREFIX = [...PREFIX, "revision"] as const;
const OBSERVATION_PREFIX = [...PREFIX, "observation"] as const;
const CHANGE_DATE_PREFIX = [...PREFIX, "change-by-date"] as const;
const CHANGE_SET_PREFIX = [...PREFIX, "change-set"] as const;
const CHANGE_PAGE_PREFIX = [...PREFIX, "change-page"] as const;
const HEAD_KEY = [...PREFIX, "meta", "head"] as const;
const PENDING_KEY = [...PREFIX, "meta", "pending"] as const;
const MAX_BATCH_KEYS = 10;
const MAX_ATOMIC_CHECKS = 100;
const MAX_SAFE_VALUE_BYTES = 48 * 1024;
const MAX_ATOMIC_STAGE_BYTES = 500 * 1024;
const CHANGE_PAGE_ITEMS = 50;

interface ImmutableItem<T> {
  readonly key: Deno.KvKey;
  readonly value: T;
  readonly encoded: string;
}

interface StoredChangePage {
  readonly encodingVersion: "change-page-v1";
  readonly kind: ChangeKind;
  readonly entries: readonly ChangeReference[];
}

export class ArchiveCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveCorruptError";
  }
}

export class KvArchive {
  constructor(private readonly kv: Deno.Kv) {}

  async stageRevision(revision: CatalogueRevision): Promise<void> {
    const eventItems: ImmutableItem<EventRecord>[] = [
      ...revision.eventsById.values(),
    ]
      .map(({ event, hash }) => ({
        key: eventKey(hash),
        value: event,
        encoded: canonicalEventJson(event),
      }));
    await this.putImmutableItems(eventItems);

    const bucketItems: ImmutableItem<readonly BucketEntry[]>[] = revision
      .buckets
      .map((bucket) => ({
        key: bucketKey(bucket.hash),
        value: bucket.entries,
        encoded: canonicalBucketJson(bucket.entries),
      }));
    await this.putImmutableItems(bucketItems);

    await this.putImmutableItems([{
      key: revisionKey(revision.hash),
      value: revision.manifest,
      encoded: canonicalRevisionJson(revision.manifest),
    }]);
  }

  async stageChangeSet(
    previousRevisionHash: string,
    revisionHash: string,
    diff: CatalogueDiff,
  ): Promise<string> {
    const references = referencesFromDiff(diff);
    const hash = await sha256Hex(JSON.stringify([
      "change-set-v1",
      previousRevisionHash,
      revisionHash,
      references,
    ]));
    const pageCounts: Record<ChangeKind, number> = {
      appeared: 0,
      disappeared: 0,
      updated: 0,
    };
    const pageItems: ImmutableItem<StoredChangePage>[] = [];

    for (const kind of changeKinds()) {
      const entries = references[kind];
      const pages = chunk(entries, CHANGE_PAGE_ITEMS);
      pageCounts[kind] = pages.length;
      pages.forEach((page, index) => {
        const value: StoredChangePage = {
          encodingVersion: "change-page-v1",
          kind,
          entries: page,
        };
        pageItems.push({
          key: changePageKey(hash, kind, index),
          value,
          encoded: JSON.stringify(value),
        });
      });
    }
    await this.putImmutableItems(pageItems);

    const manifest: ChangeSetManifest = {
      encodingVersion: "change-set-v1",
      previousRevisionHash,
      revisionHash,
      counts: {
        appeared: references.appeared.length,
        disappeared: references.disappeared.length,
        updated: references.updated.length,
      },
      pageCounts,
    };
    await this.putImmutableItems([{
      key: changeSetKey(hash),
      value: manifest,
      encoded: JSON.stringify(manifest),
    }]);
    return hash;
  }

  async loadChangeSet(hash: string): Promise<StoredChangeSet> {
    const manifestEntry = await this.kv.get<ChangeSetManifest>(
      changeSetKey(hash),
      { consistency: "strong" },
    );
    const manifest = manifestEntry.value;
    if (manifest === null || manifest.encodingVersion !== "change-set-v1") {
      throw new ArchiveCorruptError(`Missing change set ${hash}`);
    }

    const references: Record<ChangeKind, ChangeReference[]> = {
      appeared: [],
      disappeared: [],
      updated: [],
    };
    for (const kind of changeKinds()) {
      const keys = Array.from(
        { length: manifest.pageCounts[kind] },
        (_, index) => changePageKey(hash, kind, index),
      );
      const entries = await this.getMany<StoredChangePage>(keys);
      entries.forEach((entry, index) => {
        if (
          entry.value === null ||
          entry.value.encodingVersion !== "change-page-v1" ||
          entry.value.kind !== kind
        ) {
          throw new ArchiveCorruptError(
            `Missing ${kind} page ${index} for change set ${hash}`,
          );
        }
        references[kind].push(...entry.value.entries);
      });
      if (references[kind].length !== manifest.counts[kind]) {
        throw new ArchiveCorruptError(`Incorrect ${kind} count for ${hash}`);
      }
    }

    return {
      hash,
      manifest,
      diff: diffFromReferences(references),
    };
  }

  async readControl(dateInput: string): Promise<ArchiveControl> {
    const date = parseUtcDate(dateInput);
    const [head, pending, observation] = await this.kv.getMany<
      [ArchiveHead, PendingCandidate, ObservationRecord]
    >([HEAD_KEY, PENDING_KEY, observationKey(date)], {
      consistency: "strong",
    });
    return { head, pending, observation };
  }

  async commitPending(
    control: ArchiveControl,
    pending: PendingCandidate,
  ): Promise<boolean> {
    const result = await this.kv.atomic()
      .check(control.head)
      .check(control.pending)
      .check(control.observation)
      .set(PENDING_KEY, pending)
      .commit();
    return result.ok;
  }

  async commitObservation(
    control: ArchiveControl,
    input: PublishObservationInput,
  ): Promise<boolean> {
    const revision = await this.getRevisionManifest(input.revisionHash);
    if (revision.eventCount !== input.eventCount) {
      throw new ArchiveCorruptError(
        "Observation event count does not match revision",
      );
    }
    if (input.changeSetHash !== null) {
      const change = await this.kv.get<ChangeSetManifest>(
        changeSetKey(input.changeSetHash),
        { consistency: "strong" },
      );
      if (change.value === null) {
        throw new ArchiveCorruptError(
          "Observation references a missing change set",
        );
      }
    }

    const firstObservationDate = control.head.value?.firstObservationDate ??
      input.date;
    const observation: ObservationRecord = {
      date: input.date,
      fetchedAt: input.fetchedAt,
      revisionHash: input.revisionHash,
      previousObservationDate: control.head.value?.date ?? null,
      eventCount: input.eventCount,
      sourceEtag: input.sourceEtag,
      confirmedAnomaly: input.confirmedAnomaly,
    };
    const head: ArchiveHead = {
      date: input.date,
      revisionHash: input.revisionHash,
      eventCount: input.eventCount,
      firstObservationDate,
    };

    let atomic = this.kv.atomic()
      .check(control.head)
      .check(control.pending)
      .check(control.observation)
      .set(observationKey(input.date), observation)
      .set(HEAD_KEY, head);
    if (input.changeSetHash !== null) {
      atomic = atomic.set(
        changeDateKey(input.date),
        input.changeSetHash,
      );
    }
    if (control.pending.value !== null) {
      atomic = atomic.delete(PENDING_KEY);
    }
    const result = await atomic.commit();
    return result.ok;
  }

  async loadRevision(hash: string): Promise<CatalogueRevision> {
    const manifest = await this.getRevisionManifest(hash);
    const uniqueBucketHashes = [...new Set(manifest.bucketHashes)];
    const bucketEntries = await this.getMany<readonly BucketEntry[]>(
      uniqueBucketHashes.map(bucketKey),
    );
    const bucketsByHash = new Map<string, readonly BucketEntry[]>();
    for (let index = 0; index < uniqueBucketHashes.length; index += 1) {
      const bucketHash = uniqueBucketHashes[index]!;
      const entries = bucketEntries[index]!.value;
      if (entries === null) {
        throw new ArchiveCorruptError(`Missing bucket ${bucketHash}`);
      }
      await verifyHash(bucketHash, canonicalBucketJson(entries), "bucket");
      bucketsByHash.set(bucketHash, entries);
    }

    const buckets: RevisionBucket[] = manifest.bucketHashes.map(
      (bucketHash, index) => ({
        index,
        hash: bucketHash,
        entries: bucketsByHash.get(bucketHash)!,
      }),
    );
    const allEntries = buckets.flatMap((bucket) => bucket.entries);
    const uniqueEventHashes = [
      ...new Set(allEntries.map((entry) => entry.eventHash)),
    ];
    const eventEntries = await this.getMany<EventRecord>(
      uniqueEventHashes.map(eventKey),
    );
    const eventsByHash = new Map<string, EventRecord>();
    for (let index = 0; index < uniqueEventHashes.length; index += 1) {
      const eventHash = uniqueEventHashes[index]!;
      const event = eventEntries[index]!.value;
      if (event === null) {
        throw new ArchiveCorruptError(`Missing event ${eventHash}`);
      }
      await verifyHash(eventHash, canonicalEventJson(event), "event");
      eventsByHash.set(eventHash, event);
    }

    const eventsById = new Map<number, HashedEvent>();
    for (const entry of allEntries) {
      const event = eventsByHash.get(entry.eventHash);
      if (
        event === undefined || event.id !== entry.id ||
        event.slug !== entry.slug ||
        eventsById.has(entry.id)
      ) {
        throw new ArchiveCorruptError(
          "Revision bucket and event indexes disagree",
        );
      }
      const expectedBucket = await bucketIndexForSlug(entry.slug);
      const actualBucket = buckets.find((bucket) =>
        bucket.entries.includes(entry)
      )?.index;
      if (actualBucket !== expectedBucket) {
        throw new ArchiveCorruptError(
          `Slug ${entry.slug} is in the wrong bucket`,
        );
      }
      eventsById.set(entry.id, { event, hash: entry.eventHash });
    }
    if (eventsById.size !== manifest.eventCount) {
      throw new ArchiveCorruptError("Revision event count is incorrect");
    }

    return {
      hash,
      manifest,
      bucketHashes: manifest.bucketHashes,
      buckets,
      eventsById,
    };
  }

  async lookupMany(
    inputs: readonly EventLookupInput[],
  ): Promise<readonly EventLookupResult[]> {
    if (inputs.length < 1 || inputs.length > 100) {
      throw new RangeError(
        "Event lookup batch must contain 1 through 100 inputs",
      );
    }
    const normalized = inputs.map((input) => ({
      slug: input.slug.trim().toLowerCase(),
      asOf: parseUtcDate(input.asOf),
    }));
    const observations = new Map<string, ObservationRecord | null>();
    await Promise.all([...new Set(normalized.map((input) => input.asOf))].map(
      async (date) => observations.set(date, await this.findObservation(date)),
    ));

    const manifests = new Map<string, RevisionManifest>();
    const coveredRevisions = [
      ...new Set(
        [...observations.values()].flatMap((observation) =>
          observation === null ? [] : [observation.revisionHash]
        ),
      ),
    ];
    await Promise.all(coveredRevisions.map(async (hash) => {
      manifests.set(hash, await this.getRevisionManifest(hash));
    }));

    const work = await Promise.all(normalized.map(async (input, index) => {
      const observation = observations.get(input.asOf) ?? null;
      if (observation === null) {
        return { index, input, observation, bucketHash: null };
      }
      const manifest = manifests.get(observation.revisionHash)!;
      const bucketIndex = await bucketIndexForSlug(input.slug);
      return {
        index,
        input,
        observation,
        bucketHash: manifest.bucketHashes[bucketIndex]!,
      };
    }));

    const uniqueBucketHashes = [
      ...new Set(
        work.flatMap((item) =>
          item.bucketHash === null ? [] : [item.bucketHash]
        ),
      ),
    ];
    const bucketRows = await this.getMany<readonly BucketEntry[]>(
      uniqueBucketHashes.map(bucketKey),
    );
    const buckets = new Map<string, readonly BucketEntry[]>();
    for (let index = 0; index < uniqueBucketHashes.length; index += 1) {
      const hash = uniqueBucketHashes[index]!;
      const entries = bucketRows[index]!.value;
      if (entries === null) {
        throw new ArchiveCorruptError(`Missing bucket ${hash}`);
      }
      await verifyHash(hash, canonicalBucketJson(entries), "bucket");
      buckets.set(hash, entries);
    }

    const matchedEntries = work.map((item) =>
      item.bucketHash === null
        ? null
        : findBucketEntry(buckets.get(item.bucketHash)!, item.input.slug)
    );
    const uniqueEventHashes = [
      ...new Set(
        matchedEntries.flatMap((entry) =>
          entry === null ? [] : [entry.eventHash]
        ),
      ),
    ];
    const eventRows = await this.getMany<EventRecord>(
      uniqueEventHashes.map(eventKey),
    );
    const events = new Map<string, EventRecord>();
    for (let index = 0; index < uniqueEventHashes.length; index += 1) {
      const hash = uniqueEventHashes[index]!;
      const event = eventRows[index]!.value;
      if (event === null) {
        throw new ArchiveCorruptError(`Missing event ${hash}`);
      }
      await verifyHash(hash, canonicalEventJson(event), "event");
      events.set(hash, event);
    }

    return work.map((item, index): EventLookupResult => {
      const publicObservation = item.observation === null
        ? null
        : toPublicObservation(item.observation);
      const entry = matchedEntries[index]!;
      if (item.observation === null) {
        return lookupResult("NO_ARCHIVE_COVERAGE", item.input, null, null);
      }
      if (entry === null) {
        return lookupResult("NOT_FOUND", item.input, publicObservation, null);
      }
      const event = events.get(entry.eventHash);
      if (
        event === undefined || event.id !== entry.id ||
        event.slug !== entry.slug
      ) {
        throw new ArchiveCorruptError(
          "Slug index points to an inconsistent event",
        );
      }
      return lookupResult("FOUND", item.input, publicObservation, event);
    });
  }

  async listCatalogueChanges(options: {
    readonly from?: string;
    readonly through?: string;
    readonly first: number;
    readonly afterDate?: string;
  }): Promise<CatalogueChangePage> {
    if (options.first < 1 || options.first > 100) {
      throw new RangeError("Change-set page size must be between 1 and 100");
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
        "Change-set start date must not follow its end date",
      );
    }

    const startDate = afterDate === null
      ? from
      : from === null || afterDate >= from
      ? `${afterDate}\u0000`
      : from;
    const endDate = through === null ? null : nextUtcDate(through);
    const selector: Deno.KvListSelector = startDate !== null && endDate !== null
      ? { start: changeDateKey(startDate), end: changeDateKey(endDate) }
      : startDate !== null
      ? { prefix: CHANGE_DATE_PREFIX, start: changeDateKey(startDate) }
      : endDate !== null
      ? { prefix: CHANGE_DATE_PREFIX, end: changeDateKey(endDate) }
      : { prefix: CHANGE_DATE_PREFIX };
    const rows: { date: string; hash: string }[] = [];
    const iterator = this.kv.list<string>(selector, {
      limit: options.first + 1,
      consistency: "strong",
    });
    for await (const entry of iterator) {
      const date = entry.key.at(-1);
      if (typeof date !== "string") {
        throw new ArchiveCorruptError("Change index has an invalid date key");
      }
      rows.push({ date, hash: entry.value });
    }

    const hasNextPage = rows.length > options.first;
    const pageRows = rows.slice(0, options.first);
    const nodes = await Promise.all(pageRows.map(async ({ date, hash }) => {
      const observationEntry = await this.kv.get<ObservationRecord>(
        observationKey(date),
        { consistency: "strong" },
      );
      const observation = observationEntry.value;
      if (
        observation === null || observation.previousObservationDate === null
      ) {
        throw new ArchiveCorruptError(
          "Change index points to an invalid observation",
        );
      }
      const previousEntry = await this.kv.get<ObservationRecord>(
        observationKey(observation.previousObservationDate),
        { consistency: "strong" },
      );
      const previous = previousEntry.value;
      if (previous === null) {
        throw new ArchiveCorruptError(
          "Change observation has no previous observation",
        );
      }
      const manifestEntry = await this.kv.get<ChangeSetManifest>(
        changeSetKey(hash),
        { consistency: "strong" },
      );
      if (manifestEntry.value === null) {
        throw new ArchiveCorruptError(
          "Change index points to a missing change set",
        );
      }
      return {
        hash,
        observation: toPublicObservation(observation),
        previousObservation: toPublicObservation(previous),
        counts: manifestEntry.value.counts,
        confirmedAnomaly: observation.confirmedAnomaly,
      };
    }));

    return {
      nodes,
      endDate: nodes.at(-1)?.observation.date ?? null,
      hasNextPage,
    };
  }

  async getEventChanges(
    changeSetHash: string,
    kind: ChangeKind,
    options: { readonly first: number; readonly afterId?: number },
  ): Promise<EventChangePage> {
    if (options.first < 1 || options.first > 100) {
      throw new RangeError("Event-change page size must be between 1 and 100");
    }
    const stored = await this.loadChangeSet(changeSetHash);
    const references = referencesFromDiff(stored.diff)[kind];
    const start = options.afterId === undefined
      ? 0
      : references.findIndex((entry) => entry.id > options.afterId!);
    if (start === -1) {
      return { nodes: [], endId: null, hasNextPage: false };
    }
    const selected = references.slice(start, start + options.first + 1);
    const hasNextPage = selected.length > options.first;
    const pageReferences = selected.slice(0, options.first);
    const hashes = [
      ...new Set(pageReferences.flatMap((entry) => [
        ...(entry.beforeHash === null ? [] : [entry.beforeHash]),
        ...(entry.afterHash === null ? [] : [entry.afterHash]),
      ])),
    ];
    const eventEntries = await this.getMany<EventRecord>(hashes.map(eventKey));
    const events = new Map<string, EventRecord>();
    for (let index = 0; index < hashes.length; index += 1) {
      const hash = hashes[index]!;
      const event = eventEntries[index]!.value;
      if (event === null) {
        throw new ArchiveCorruptError(
          `Change references missing event ${hash}`,
        );
      }
      await verifyHash(hash, canonicalEventJson(event), "event");
      events.set(hash, event);
    }

    const nodes = pageReferences.map((reference) => {
      const before = reference.beforeHash === null
        ? null
        : events.get(reference.beforeHash) ?? null;
      const after = reference.afterHash === null
        ? null
        : events.get(reference.afterHash) ?? null;
      if (
        (reference.beforeHash !== null && before === null) ||
        (reference.afterHash !== null && after === null) ||
        (before !== null && before.id !== reference.id) ||
        (after !== null && after.id !== reference.id)
      ) {
        throw new ArchiveCorruptError("Change event identity is inconsistent");
      }
      return {
        id: reference.id,
        before,
        after,
        changedFields: reference.changedFields,
      };
    });
    return {
      nodes,
      endId: nodes.at(-1)?.id ?? null,
      hasNextPage,
    };
  }

  async getArchiveInfo(): Promise<ArchiveInfo> {
    const head = await this.kv.get<ArchiveHead>(HEAD_KEY, {
      consistency: "strong",
    });
    if (head.value === null) {
      return {
        firstObservation: null,
        latestObservation: null,
        latestEventCount: null,
      };
    }
    const [first, latest] = await this.kv.getMany<
      [ObservationRecord, ObservationRecord]
    >([
      observationKey(head.value.firstObservationDate),
      observationKey(head.value.date),
    ], { consistency: "strong" });
    if (first.value === null || latest.value === null) {
      throw new ArchiveCorruptError(
        "Archive head points to a missing observation",
      );
    }
    return {
      firstObservation: toPublicObservation(first.value),
      latestObservation: toPublicObservation(latest.value),
      latestEventCount: head.value.eventCount,
    };
  }

  private async findObservation(
    date: string,
  ): Promise<ObservationRecord | null> {
    const exact = await this.kv.get<ObservationRecord>(observationKey(date), {
      consistency: "strong",
    });
    if (exact.value !== null) return exact.value;

    const iterator = this.kv.list<ObservationRecord>({
      prefix: OBSERVATION_PREFIX,
      end: observationKey(nextUtcDate(date)),
    }, {
      reverse: true,
      limit: 1,
      consistency: "strong",
    });
    for await (const entry of iterator) return entry.value;
    return null;
  }

  private async getRevisionManifest(hash: string): Promise<RevisionManifest> {
    const entry = await this.kv.get<RevisionManifest>(revisionKey(hash), {
      consistency: "strong",
    });
    const manifest = entry.value;
    if (
      manifest === null || manifest.encodingVersion !== "revision-v1" ||
      manifest.bucketHashes.length !== 256
    ) {
      throw new ArchiveCorruptError(`Missing revision ${hash}`);
    }
    await verifyHash(hash, canonicalRevisionJson(manifest), "revision");
    return manifest;
  }

  private async getMany<T>(
    keys: readonly Deno.KvKey[],
  ): Promise<readonly Deno.KvEntryMaybe<T>[]> {
    const result: Deno.KvEntryMaybe<T>[] = [];
    for (const keysChunk of chunk(keys, MAX_BATCH_KEYS)) {
      const entries = await this.kv.getMany(
        keysChunk as [Deno.KvKey, ...Deno.KvKey[]],
        { consistency: "strong" },
      );
      result.push(...entries as Deno.KvEntryMaybe<T>[]);
    }
    return result;
  }

  private async putImmutableItems<T>(
    sourceItems: readonly ImmutableItem<T>[],
  ): Promise<void> {
    const uniqueItems = new Map<string, ImmutableItem<T>>();
    for (const item of sourceItems) {
      assertSafeValue(item.encoded);
      const keyString = JSON.stringify(item.key);
      const existing = uniqueItems.get(keyString);
      if (existing !== undefined && existing.encoded !== item.encoded) {
        throw new ArchiveCorruptError("One content key has conflicting values");
      }
      uniqueItems.set(keyString, item);
    }

    for (const items of chunkImmutableItems([...uniqueItems.values()])) {
      await this.putImmutableChunk(items, 0);
    }
  }

  private async putImmutableChunk<T>(
    items: readonly ImmutableItem<T>[],
    attempt: number,
  ): Promise<void> {
    const existing = await this.getMany<T>(items.map((item) => item.key));
    let atomic = this.kv.atomic();
    let mutations = 0;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      const entry = existing[index]!;
      if (entry.value !== null) {
        if (JSON.stringify(entry.value) !== JSON.stringify(item.value)) {
          throw new ArchiveCorruptError(
            `Content-addressed key ${
              JSON.stringify(item.key)
            } has different data`,
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
      throw new Error(
        "Could not stage immutable KV content after three attempts",
      );
    }
    await this.putImmutableChunk(items, attempt + 1);
  }
}

function referencesFromDiff(
  diff: CatalogueDiff,
): Record<ChangeKind, readonly ChangeReference[]> {
  return {
    appeared: diff.appeared.map((change) => ({
      id: change.id,
      beforeHash: null,
      afterHash: change.afterHash,
      changedFields: [],
    })),
    disappeared: diff.disappeared.map((change) => ({
      id: change.id,
      beforeHash: change.beforeHash,
      afterHash: null,
      changedFields: [],
    })),
    updated: diff.updated.map((change) => ({
      id: change.id,
      beforeHash: change.beforeHash,
      afterHash: change.afterHash,
      changedFields: change.changedFields,
    })),
  };
}

function diffFromReferences(
  references: Record<ChangeKind, readonly ChangeReference[]>,
): CatalogueDiff {
  return {
    appeared: references.appeared.map((entry) => ({
      id: entry.id,
      afterHash: entry.afterHash!,
    })),
    disappeared: references.disappeared.map((entry) => ({
      id: entry.id,
      beforeHash: entry.beforeHash!,
    })),
    updated: references.updated.map((entry) => ({
      id: entry.id,
      beforeHash: entry.beforeHash!,
      afterHash: entry.afterHash!,
      changedFields: entry.changedFields,
    })),
  };
}

function changeKinds(): readonly ChangeKind[] {
  return ["appeared", "disappeared", "updated"];
}

function eventKey(hash: string): Deno.KvKey {
  return [...EVENT_PREFIX, hash];
}

function bucketKey(hash: string): Deno.KvKey {
  return [...BUCKET_PREFIX, hash];
}

function revisionKey(hash: string): Deno.KvKey {
  return [...REVISION_PREFIX, hash];
}

function observationKey(date: string): Deno.KvKey {
  return [...OBSERVATION_PREFIX, date];
}

function changeDateKey(date: string): Deno.KvKey {
  return [...CHANGE_DATE_PREFIX, date];
}

function changeSetKey(hash: string): Deno.KvKey {
  return [...CHANGE_SET_PREFIX, hash];
}

function changePageKey(
  hash: string,
  kind: ChangeKind,
  page: number,
): Deno.KvKey {
  return [...CHANGE_PAGE_PREFIX, hash, kind, page];
}

function toPublicObservation(
  observation: ObservationRecord,
): PublicObservation {
  return { date: observation.date, fetchedAt: observation.fetchedAt };
}

function lookupResult(
  status: EventLookupResult["status"],
  input: EventLookupInput,
  observation: PublicObservation | null,
  event: EventRecord | null,
): EventLookupResult {
  return {
    status,
    requestedSlug: input.slug,
    requestedDate: input.asOf,
    observation,
    event,
  };
}

function findBucketEntry(
  entries: readonly BucketEntry[],
  slug: string,
): BucketEntry | null {
  let low = 0;
  let high = entries.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const entry = entries[middle]!;
    const comparison = entry.slug.localeCompare(slug);
    if (comparison === 0) return entry;
    if (comparison < 0) low = middle + 1;
    else high = middle - 1;
  }
  return null;
}

async function verifyHash(
  expected: string,
  encoded: string,
  kind: string,
): Promise<void> {
  if (await sha256Hex(encoded) !== expected) {
    throw new ArchiveCorruptError(
      `Stored ${kind} content failed hash verification`,
    );
  }
}

function assertSafeValue(encoded: string): void {
  const size = new TextEncoder().encode(encoded).byteLength;
  if (size > MAX_SAFE_VALUE_BYTES) {
    throw new RangeError(
      `KV value is ${size} bytes; maximum safe size is ${MAX_SAFE_VALUE_BYTES}`,
    );
  }
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function chunkImmutableItems<T>(
  items: readonly ImmutableItem<T>[],
): ImmutableItem<T>[][] {
  const groups: ImmutableItem<T>[][] = [];
  let group: ImmutableItem<T>[] = [];
  let groupBytes = 0;
  for (const item of items) {
    const itemBytes = new TextEncoder().encode(item.encoded).byteLength +
      new TextEncoder().encode(JSON.stringify(item.key)).byteLength;
    if (
      group.length > 0 &&
      (group.length >= MAX_ATOMIC_CHECKS ||
        groupBytes + itemBytes > MAX_ATOMIC_STAGE_BYTES)
    ) {
      groups.push(group);
      group = [];
      groupBytes = 0;
    }
    group.push(item);
    groupBytes += itemBytes;
  }
  if (group.length > 0) groups.push(group);
  return groups;
}
