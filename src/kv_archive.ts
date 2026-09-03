import type {
  ArchiveControl,
  ArchiveHead,
  ArchiveInfo,
  CatalogueChangePage,
  ChangeKind,
  ChangeReference,
  ChangeSetManifest,
  CountryInfo,
  EventChangePage,
  EventLookupInput,
  EventLookupResult,
  ObservationRecord,
  PendingCandidate,
  PublicObservation,
  PublishObservationInput,
  StoredChangeSet,
} from "./archive.ts";
import { mapWithConcurrency } from "./concurrency.ts";
import { parseUtcDate } from "./date.ts";
import {
  bucketIndexForSlug,
  canonicalBucketJson,
  canonicalEventJson,
  canonicalRevisionJson,
  compareSlugs,
  sha256Hex,
} from "./model.ts";
import type {
  BucketEntry,
  CatalogueDiff,
  CatalogueRevision,
  EventField,
  EventRecord,
  HashedEvent,
  RevisionBucket,
  RevisionManifest,
} from "./model.ts";

const PREFIX = ["parkrun-events", "v1"] as const;
const EVENT_PREFIX = [...PREFIX, "event"] as const;
const BUCKET_PREFIX = [...PREFIX, "bucket"] as const;
const REVISION_PREFIX = [...PREFIX, "revision"] as const;
const REVISION_ID_PREFIX = [...PREFIX, "revision-id"] as const;
const REVISION_ID_INDEXED_PREFIX = [...PREFIX, "revision-id-indexed"] as const;
const REVISION_COUNTRIES_PREFIX = [...PREFIX, "revision-countries"] as const;
const OBSERVATION_PREFIX = [...PREFIX, "observation"] as const;
const CHANGE_DATE_PREFIX = [...PREFIX, "change-by-date"] as const;
const CHANGE_SET_PREFIX = [...PREFIX, "change-set"] as const;
const CHANGE_PAGE_PREFIX = [...PREFIX, "change-page"] as const;
const HEAD_KEY = [...PREFIX, "meta", "head"] as const;
const PENDING_KEY = [...PREFIX, "meta", "pending"] as const;
const MAX_BATCH_KEYS = 10;
const MAX_READ_CONCURRENCY = 8;
const MAX_ATOMIC_CHECKS = 100;
const MAX_SAFE_VALUE_BYTES = 48 * 1024;
const MAX_ATOMIC_STAGE_BYTES = 500 * 1024;
const CHANGE_PAGE_ITEMS = 50;
const MAX_ARCHIVE_EVENT_COUNT = 100_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

interface RevisionIdEntry {
  readonly slug: string;
  readonly eventHash: string;
}

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
        encoded: JSON.stringify(event),
      }));
    await this.putImmutableItems(eventItems);

    const bucketItems: ImmutableItem<readonly BucketEntry[]>[] = revision
      .buckets
      .map((bucket) => ({
        key: bucketKey(bucket.hash),
        value: bucket.entries,
        encoded: JSON.stringify(bucket.entries),
      }));
    await this.putImmutableItems(bucketItems);

    const idItems: ImmutableItem<RevisionIdEntry>[] = [
      ...revision.eventsById.values(),
    ].map(({ event, hash }) => ({
      key: revisionIdKey(revision.hash, event.id),
      value: { slug: event.slug, eventHash: hash },
      encoded: JSON.stringify([event.slug, hash]),
    }));
    await this.putImmutableItems(idItems);

    await this.putImmutableItems([
      {
        key: revisionKey(revision.hash),
        value: revision.manifest,
        encoded: JSON.stringify(revision.manifest),
      },
    ]);

    await this.putImmutableItems([
      {
        key: revisionCountriesKey(revision.hash),
        value: revision.countries,
        encoded: JSON.stringify(revision.countries),
      },
    ]);
    await this.putImmutableItems([
      {
        key: revisionIdIndexedKey(revision.hash),
        value: true,
        encoded: JSON.stringify(true),
      },
    ]);
  }

  async ensureRevisionIndexed(
    revisionHash: string,
  ): Promise<Map<number, RevisionIdEntry> | null> {
    const isIndexed = await this.isRevisionIdIndexed(revisionHash);
    if (isIndexed) {
      return null;
    }

    const manifest = await this.getRevisionManifest(revisionHash);
    const uniqueBucketHashes = [...new Set(manifest.bucketHashes)];
    const bucketRows = await this.getMany<readonly BucketEntry[]>(
      uniqueBucketHashes.map(bucketKey),
    );
    const bucketsByHash = new Map<string, readonly BucketEntry[]>();
    for (let index = 0; index < uniqueBucketHashes.length; index += 1) {
      const bucketHash = uniqueBucketHashes[index]!;
      const entries = bucketRows[index]!.value;
      if (entries === null) {
        throw new ArchiveCorruptError(`Missing bucket ${bucketHash}`);
      }
      await verifyHash(bucketHash, canonicalBucketJson(entries), "bucket");
      bucketsByHash.set(bucketHash, entries);
    }

    const entriesById = new Map<number, RevisionIdEntry>();
    for (const bucketHash of uniqueBucketHashes) {
      const entries = bucketsByHash.get(bucketHash)!;
      for (const entry of entries) {
        entriesById.set(entry.id, {
          slug: entry.slug,
          eventHash: entry.eventHash,
        });
      }
    }

    if (entriesById.size !== manifest.eventCount) {
      throw new ArchiveCorruptError(
        "Revision bucket index does not match event count",
      );
    }

    const idItems: ImmutableItem<RevisionIdEntry>[] = [
      ...entriesById.entries(),
    ].map(([id, value]) => ({
      key: revisionIdKey(revisionHash, id),
      value,
      encoded: JSON.stringify([value.slug, value.eventHash]),
    }));

    await this.putImmutableItems(idItems);
    await this.putImmutableItems([
      {
        key: revisionIdIndexedKey(revisionHash),
        value: true,
        encoded: JSON.stringify(true),
      },
    ]);

    return entriesById;
  }

  async ensureCountriesIndexed(
    revisionHash: string,
  ): Promise<readonly CountryInfo[] | null> {
    const isIndexed = await this.isRevisionCountriesIndexed(revisionHash);
    if (isIndexed) {
      return null;
    }
    const revision = await this.loadRevision(revisionHash);
    await this.putImmutableItems([
      {
        key: revisionCountriesKey(revision.hash),
        value: revision.countries,
        encoded: JSON.stringify(revision.countries),
      },
    ]);
    return revision.countries;
  }

  private async isRevisionIdIndexed(hash: string): Promise<boolean> {
    const [indexedEntry, countryEntry] = await this.getMany<unknown>([
      revisionIdIndexedKey(hash),
      revisionCountriesKey(hash),
    ]);
    return (
      (indexedEntry?.value !== null && indexedEntry?.value !== undefined) ||
      (countryEntry?.value !== null && countryEntry?.value !== undefined)
    );
  }

  private async isRevisionCountriesIndexed(hash: string): Promise<boolean> {
    const check = await this.kv.get<readonly CountryInfo[]>(
      revisionCountriesKey(hash),
      { consistency: "strong" },
    );
    return check.value !== null;
  }

  async backfillIndexes(options?: {
    readonly apply?: boolean;
    readonly onProgress?: (progress: {
      readonly revisionHash: string;
      readonly current: number;
      readonly total: number;
      readonly newlyIndexed: boolean;
      readonly newlyIndexedIds?: boolean;
      readonly newlyIndexedCountries?: boolean;
    }) => void;
  }): Promise<{
    readonly totalObservations: number;
    readonly totalRevisions: number;
    readonly newlyIndexedRevisions: number;
  }> {
    const apply = options?.apply ?? true;
    const revisions = new Set<string>();
    let observationCount = 0;
    const entries = this.kv.list<ObservationRecord>({
      prefix: OBSERVATION_PREFIX,
    }, { consistency: "strong" });
    for await (const entry of entries) {
      observationCount += 1;
      revisions.add(entry.value.revisionHash);
    }
    let newlyIndexedRevisions = 0;
    let current = 0;
    for (const hash of revisions) {
      current += 1;
      let newlyIndexedIds = false;
      let newlyIndexedCountries = false;
      if (apply) {
        const idResult = await this.ensureRevisionIndexed(hash);
        if (idResult !== null) {
          newlyIndexedIds = true;
        }
        const countryResult = await this.ensureCountriesIndexed(hash);
        if (countryResult !== null) {
          newlyIndexedCountries = true;
        }
        if (newlyIndexedIds || newlyIndexedCountries) {
          newlyIndexedRevisions += 1;
        }
      } else {
        const isIdIndexed = await this.isRevisionIdIndexed(hash);
        const isCountryIndexed = await this.isRevisionCountriesIndexed(hash);
        newlyIndexedIds = !isIdIndexed;
        newlyIndexedCountries = !isCountryIndexed;
        if (newlyIndexedIds || newlyIndexedCountries) {
          newlyIndexedRevisions += 1;
        }
      }
      options?.onProgress?.({
        revisionHash: hash,
        current,
        total: revisions.size,
        newlyIndexed: newlyIndexedIds || newlyIndexedCountries,
        newlyIndexedIds,
        newlyIndexedCountries,
      });
    }
    return {
      totalObservations: observationCount,
      totalRevisions: revisions.size,
      newlyIndexedRevisions,
    };
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
    validateHash(hash, "change set hash");
    const manifestEntry = await this.kv.get<unknown>(changeSetKey(hash), {
      consistency: "strong",
    });
    if (manifestEntry.value === null) {
      throw new ArchiveCorruptError(`Missing change set ${hash}`);
    }
    const manifest = validateChangeSetManifest(manifestEntry.value);

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
      const entries = await this.getMany<unknown>(keys);
      entries.forEach((entry, index) => {
        if (entry.value === null) {
          throw new ArchiveCorruptError(
            `Missing ${kind} page ${index} for change set ${hash}`,
          );
        }
        const page = validateChangePage(entry.value, kind);
        references[kind].push(...page.entries);
      });
      if (references[kind].length !== manifest.counts[kind]) {
        throw new ArchiveCorruptError(`Incorrect ${kind} count for ${hash}`);
      }
    }

    const expectedHash = await sha256Hex(JSON.stringify([
      "change-set-v1",
      manifest.previousRevisionHash,
      manifest.revisionHash,
      references,
    ]));
    if (expectedHash !== hash) {
      throw new ArchiveCorruptError(
        `Change set ${hash} failed hash verification`,
      );
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
    if (head.value !== null) validateHeadRecord(head.value);
    if (pending.value !== null) validatePendingRecord(pending.value);
    if (observation.value !== null) {
      validateObservationRecord(observation.value, date);
    }
    if (
      head.value !== null && pending.value !== null &&
      pending.value.firstSeenDate <= head.value.date
    ) {
      throw new ArchiveCorruptError(
        "Pending candidate does not follow the head",
      );
    }
    return { head, pending, observation };
  }

  async commitPending(
    control: ArchiveControl,
    pending: PendingCandidate,
  ): Promise<boolean> {
    validatePendingRecord(pending);
    if (
      control.head.value === null ||
      pending.baseRevisionHash !== control.head.value.revisionHash
    ) {
      throw new ArchiveCorruptError(
        "Pending candidate baseline does not match the archive head",
      );
    }
    const candidateRevision = await this.getRevisionManifest(
      pending.candidateRevisionHash,
    );
    if (candidateRevision.eventCount !== pending.eventCount) {
      throw new ArchiveCorruptError(
        "Pending candidate event count does not match its revision",
      );
    }
    const changeSet = await this.loadChangeSet(pending.changeSetHash);
    if (
      changeSet.manifest.previousRevisionHash !== pending.baseRevisionHash ||
      changeSet.manifest.revisionHash !== pending.candidateRevisionHash
    ) {
      throw new ArchiveCorruptError(
        "Pending candidate does not match its change set",
      );
    }
    assertSafeValue(JSON.stringify(pending));
    if (
      control.head.value !== null &&
      pending.firstSeenDate <= control.head.value.date
    ) {
      throw new RangeError(
        "Pending candidate date must follow the archive head",
      );
    }
    if (
      control.pending.value !== null &&
      pending.firstSeenDate <= control.pending.value.firstSeenDate
    ) {
      throw new RangeError(
        "Replacement candidate date must follow the pending candidate",
      );
    }
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
    if (control.head.value !== null && input.date <= control.head.value.date) {
      throw new RangeError("Observation date must follow the archive head");
    }
    if (
      control.pending.value !== null &&
      input.date <= control.pending.value.firstSeenDate
    ) {
      throw new RangeError(
        "Observation date must follow the pending candidate",
      );
    }
    const revision = await this.getRevisionManifest(input.revisionHash);
    if (revision.eventCount !== input.eventCount) {
      throw new ArchiveCorruptError(
        "Observation event count does not match revision",
      );
    }
    const revisionChanged = control.head.value !== null &&
      control.head.value.revisionHash !== input.revisionHash;
    if (revisionChanged !== (input.changeSetHash !== null)) {
      throw new ArchiveCorruptError(
        "Observation change set does not match its revision transition",
      );
    }
    if (input.changeSetHash !== null) {
      const changeSet = await this.loadChangeSet(input.changeSetHash);
      if (
        control.head.value === null ||
        changeSet.manifest.previousRevisionHash !==
          control.head.value.revisionHash ||
        changeSet.manifest.revisionHash !== input.revisionHash
      ) {
        throw new ArchiveCorruptError(
          "Observation change set does not link its revisions",
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
    validateObservationRecord(observation, input.date);
    validateHeadRecord(head);
    assertSafeValue(JSON.stringify(observation));
    assertSafeValue(JSON.stringify(head));

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

    const countryMap = new Map<
      number,
      { code: number; url: string; count: number }
    >();
    for (const { event } of eventsById.values()) {
      const existing = countryMap.get(event.countryCode);
      if (existing === undefined) {
        countryMap.set(event.countryCode, {
          code: event.countryCode,
          url: event.countryUrl,
          count: 1,
        });
      } else {
        existing.count += 1;
      }
    }
    const countries = [...countryMap.values()]
      .sort((left, right) => left.code - right.code)
      .map((item) => ({
        code: item.code,
        url: item.url,
        eventCount: item.count,
      }));
    const countryCodes = countries.map((c) => c.code);

    return {
      hash,
      manifest,
      bucketHashes: manifest.bucketHashes,
      buckets,
      eventsById,
      countries,
      countryCodes,
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
    const normalized = inputs.map((input) => {
      const hasId = input.id !== undefined && input.id !== null;
      const hasSlug = input.slug !== undefined && input.slug !== null;
      if (!hasId && !hasSlug) {
        throw new RangeError("Each lookup input must provide an id or slug");
      }
      if (
        hasId &&
        (!Number.isSafeInteger(input.id) || (input.id as number) <= 0)
      ) {
        throw new RangeError("Event ID must be a positive integer");
      }
      const slug = hasSlug ? input.slug!.trim().toLowerCase() : undefined;
      return {
        id: hasId ? (input.id as number) : undefined,
        slug,
        asOf: parseUtcDate(input.asOf),
        fallbackToEarliest: input.fallbackToEarliest ?? true,
      };
    });

    const headEntry = await this.kv.get<ArchiveHead>(HEAD_KEY, {
      consistency: "strong",
    });
    const head = headEntry.value;

    if (head === null) {
      return normalized.map((input) =>
        lookupResult("NO_ARCHIVE_COVERAGE", input, null, null)
      );
    }

    validateHeadRecord(head);

    const targetDates = normalized.map((input) => {
      if (input.asOf < head.firstObservationDate) {
        return input.fallbackToEarliest ? head.firstObservationDate : null;
      }
      return input.asOf;
    });

    const uniqueDates = [
      ...new Set(targetDates.filter((date): date is string => date !== null)),
    ];
    const resolvedObservations = await mapWithConcurrency(
      uniqueDates,
      MAX_READ_CONCURRENCY,
      (date) => this.findObservation(date),
    );
    const observations = new Map<string, ObservationRecord | null>();
    uniqueDates.forEach((date, index) => {
      observations.set(date, resolvedObservations[index]!);
    });

    const inputObservations = targetDates.map((targetDate) =>
      targetDate === null ? null : observations.get(targetDate) ?? null
    );

    const revisionsNeedingManifest = [
      ...new Set(
        normalized
          .map((input, index) => ({ input, obs: inputObservations[index] }))
          .filter(({ input, obs }) => input.id === undefined && obs !== null)
          .map(({ obs }) => obs!.revisionHash),
      ),
    ];

    const manifests = new Map<string, RevisionManifest>();
    if (revisionsNeedingManifest.length > 0) {
      const resolvedManifests = await mapWithConcurrency(
        revisionsNeedingManifest,
        MAX_READ_CONCURRENCY,
        (hash) => this.getRevisionManifest(hash),
      );
      revisionsNeedingManifest.forEach((hash, index) => {
        manifests.set(hash, resolvedManifests[index]!);
      });
      for (const [index, obs] of inputObservations.entries()) {
        if (obs !== null && normalized[index]!.id === undefined) {
          if (manifests.get(obs.revisionHash)?.eventCount !== obs.eventCount) {
            throw new ArchiveCorruptError(
              "Observation event count does not match its revision",
            );
          }
        }
      }
    }

    interface ItemLookupWork {
      readonly index: number;
      readonly input: (typeof normalized)[number];
      readonly observation: ObservationRecord | null;
      readonly isIdLookup: boolean;
      readonly bucketHash: string | null;
    }

    const work: ItemLookupWork[] = await Promise.all(
      normalized.map(async (input, index) => {
        const observation = inputObservations[index]!;
        if (observation === null) {
          return {
            index,
            input,
            observation: null,
            isIdLookup: false,
            bucketHash: null,
          };
        }
        if (input.id !== undefined) {
          return {
            index,
            input,
            observation,
            isIdLookup: true,
            bucketHash: null,
          };
        }
        const manifest = manifests.get(observation.revisionHash)!;
        const bucketIndex = await bucketIndexForSlug(input.slug!);
        return {
          index,
          input,
          observation,
          isIdLookup: false,
          bucketHash: manifest.bucketHashes[bucketIndex]!,
        };
      }),
    );

    const idWork = work.filter((item) => item.isIdLookup);
    const uniqueIdKeys = [
      ...new Set(
        idWork.map((item) =>
          JSON.stringify(
            revisionIdKey(item.observation!.revisionHash, item.input.id!),
          )
        ),
      ),
    ].map((keyJson) => JSON.parse(keyJson) as Deno.KvKey);

    const idEntriesByKey = new Map<string, RevisionIdEntry | null>();
    const idRows = await this.getMany<RevisionIdEntry>(uniqueIdKeys);
    uniqueIdKeys.forEach((key, index) => {
      idEntriesByKey.set(JSON.stringify(key), idRows[index]!.value);
    });

    const candidateRevisionHashes = [
      ...new Set(
        idWork
          .filter((item) => {
            const key = JSON.stringify(
              revisionIdKey(item.observation!.revisionHash, item.input.id!),
            );
            return idEntriesByKey.get(key) === null;
          })
          .map((item) => item.observation!.revisionHash),
      ),
    ];

    for (const revisionHash of candidateRevisionHashes) {
      const newlyIndexed = await this.ensureRevisionIndexed(revisionHash);
      if (newlyIndexed !== null) {
        for (const item of idWork) {
          if (item.observation!.revisionHash === revisionHash) {
            const key = JSON.stringify(
              revisionIdKey(revisionHash, item.input.id!),
            );
            const entry = newlyIndexed.get(item.input.id!);
            if (entry !== undefined) {
              idEntriesByKey.set(key, entry);
            }
          }
        }
      }
    }

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

    const itemEventHashes: (string | null)[] = work.map((item) => {
      if (item.observation === null) return null;
      if (item.isIdLookup) {
        const key = JSON.stringify(
          revisionIdKey(item.observation.revisionHash, item.input.id!),
        );
        const entry = idEntriesByKey.get(key) ?? null;
        if (entry === null) return null;
        if (item.input.slug !== undefined && entry.slug !== item.input.slug) {
          return null;
        }
        return entry.eventHash;
      }
      const bucketEntries = buckets.get(item.bucketHash!)!;
      const entry = findBucketEntry(bucketEntries, item.input.slug!);
      return entry?.eventHash ?? null;
    });

    const uniqueEventHashes = [
      ...new Set(
        itemEventHashes.filter((hash): hash is string => hash !== null),
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
      if (item.observation === null) {
        return lookupResult("NO_ARCHIVE_COVERAGE", item.input, null, null);
      }
      const publicObservation = toPublicObservation(item.observation);
      const eventHash = itemEventHashes[index]!;
      if (eventHash === null) {
        return lookupResult("NOT_FOUND", item.input, publicObservation, null);
      }
      const event = events.get(eventHash);
      if (
        event === undefined ||
        (item.input.id !== undefined && event.id !== item.input.id) ||
        (item.input.slug !== undefined && event.slug !== item.input.slug)
      ) {
        throw new ArchiveCorruptError(
          "Event index points to an inconsistent event",
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
    const endDate = through === null ? null : `${through}\u0000`;
    const selector: Deno.KvListSelector = startDate !== null && endDate !== null
      ? { start: changeDateKey(startDate), end: changeDateKey(endDate) }
      : startDate !== null
      ? { prefix: CHANGE_DATE_PREFIX, start: changeDateKey(startDate) }
      : endDate !== null
      ? { prefix: CHANGE_DATE_PREFIX, end: changeDateKey(endDate) }
      : { prefix: CHANGE_DATE_PREFIX };
    const rows: { date: string; hash: string }[] = [];
    const iterator = this.kv.list<unknown>(selector, {
      limit: options.first + 1,
      consistency: "strong",
    });
    for await (const entry of iterator) {
      const date = entry.key.at(-1);
      if (typeof date !== "string" || typeof entry.value !== "string") {
        throw new ArchiveCorruptError("Change index has an invalid entry");
      }
      parseStoredDate(date, "change index date");
      validateHash(entry.value, "change index hash");
      rows.push({ date, hash: entry.value });
    }

    const hasNextPage = rows.length > options.first;
    const pageRows = rows.slice(0, options.first);
    const nodes = await mapWithConcurrency(
      pageRows,
      MAX_READ_CONCURRENCY,
      async ({ date, hash }) => {
        const observationEntry = await this.kv.get<ObservationRecord>(
          observationKey(date),
          { consistency: "strong" },
        );
        const observation = observationEntry.value;
        if (observation !== null) validateObservationRecord(observation, date);
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
        if (previous !== null) {
          validateObservationRecord(
            previous,
            observation.previousObservationDate,
          );
        }
        if (previous === null) {
          throw new ArchiveCorruptError(
            "Change observation has no previous observation",
          );
        }
        const changeSet = await this.loadChangeSet(hash);
        if (
          changeSet.manifest.previousRevisionHash !== previous.revisionHash ||
          changeSet.manifest.revisionHash !== observation.revisionHash
        ) {
          throw new ArchiveCorruptError(
            "Change set does not link its observations",
          );
        }
        return {
          hash,
          observation: toPublicObservation(observation),
          previousObservation: toPublicObservation(previous),
          counts: changeSet.manifest.counts,
          confirmedAnomaly: observation.confirmedAnomaly,
        };
      },
    );

    return {
      nodes,
      endDate: nodes.at(-1)?.observation.date ?? null,
      hasNextPage,
    };
  }

  async getEventChanges(
    changeSetHash: string,
    kind: ChangeKind,
    options: {
      readonly first: number;
      readonly afterId?: number;
      readonly changeSet?: StoredChangeSet;
    },
  ): Promise<EventChangePage> {
    if (options.first < 1 || options.first > 100) {
      throw new RangeError("Event-change page size must be between 1 and 100");
    }
    const stored = options.changeSet ?? await this.loadChangeSet(changeSetHash);
    if (stored.hash !== changeSetHash) {
      throw new ArchiveCorruptError("Loaded change set has an unexpected hash");
    }
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

  async getCountries(asOf?: string): Promise<readonly CountryInfo[]> {
    const head = await this.kv.get<ArchiveHead>(HEAD_KEY, {
      consistency: "strong",
    });
    if (head.value === null) {
      return [];
    }
    validateHeadRecord(head.value);

    let targetDate: string;
    if (asOf !== undefined && asOf !== null) {
      const parsedDate = parseUtcDate(asOf);
      targetDate = parsedDate < head.value.firstObservationDate
        ? head.value.firstObservationDate
        : parsedDate;
    } else {
      targetDate = head.value.date;
    }

    const observation = await this.findObservation(targetDate);
    if (observation === null) {
      return [];
    }

    const cached = await this.kv.get<readonly CountryInfo[]>(
      revisionCountriesKey(observation.revisionHash),
      { consistency: "strong" },
    );
    if (cached.value !== null) {
      return cached.value;
    }

    const revision = await this.loadRevision(observation.revisionHash);
    await this.putImmutableItems([
      {
        key: revisionCountriesKey(observation.revisionHash),
        value: revision.countries,
        encoded: JSON.stringify(revision.countries),
      },
    ]);
    return revision.countries;
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
        latestCountryCodes: [],
      };
    }
    validateHeadRecord(head.value);
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
    validateObservationRecord(first.value, head.value.firstObservationDate);
    validateObservationRecord(latest.value, head.value.date);
    if (
      first.value.previousObservationDate !== null ||
      latest.value.revisionHash !== head.value.revisionHash ||
      latest.value.eventCount !== head.value.eventCount
    ) {
      throw new ArchiveCorruptError(
        "Archive head does not match its observations",
      );
    }
    const revision = await this.getRevisionManifest(latest.value.revisionHash);
    if (revision.eventCount !== latest.value.eventCount) {
      throw new ArchiveCorruptError(
        "Latest observation does not match its revision",
      );
    }
    const countries = await this.getCountries(head.value.date);
    const latestCountryCodes = countries.map((country) => country.code);

    return {
      firstObservation: toPublicObservation(first.value),
      latestObservation: toPublicObservation(latest.value),
      latestEventCount: latest.value.eventCount,
      latestCountryCodes,
    };
  }

  private async findObservation(
    date: string,
  ): Promise<ObservationRecord | null> {
    const exact = await this.kv.get<ObservationRecord>(observationKey(date), {
      consistency: "strong",
    });
    if (exact.value !== null) {
      validateObservationRecord(exact.value, date);
      return exact.value;
    }

    const iterator = this.kv.list<ObservationRecord>({
      prefix: OBSERVATION_PREFIX,
      end: observationKey(`${date}\u0000`),
    }, {
      reverse: true,
      limit: 1,
      consistency: "strong",
    });
    for await (const entry of iterator) {
      const keyDate = entry.key.at(-1);
      if (typeof keyDate !== "string") {
        throw new ArchiveCorruptError("Observation has an invalid key");
      }
      validateObservationRecord(entry.value, keyDate);
      return entry.value;
    }
    return null;
  }

  private async getRevisionManifest(hash: string): Promise<RevisionManifest> {
    validateHash(hash, "revision hash");
    const entry = await this.kv.get<unknown>(revisionKey(hash), {
      consistency: "strong",
    });
    if (entry.value === null) {
      throw new ArchiveCorruptError(`Missing revision ${hash}`);
    }
    const manifest = validateRevisionManifest(entry.value);
    await verifyHash(hash, canonicalRevisionJson(manifest), "revision");
    return manifest;
  }

  private async getMany<T>(
    keys: readonly Deno.KvKey[],
  ): Promise<readonly Deno.KvEntryMaybe<T>[]> {
    if (keys.length === 0) {
      return [];
    }
    const keysChunks = chunk(keys, MAX_BATCH_KEYS);
    const chunkResults = await mapWithConcurrency(
      keysChunks,
      MAX_READ_CONCURRENCY,
      (keysChunk) =>
        this.kv.getMany(
          keysChunk as [Deno.KvKey, ...Deno.KvKey[]],
          { consistency: "strong" },
        ),
    );
    return chunkResults.flat() as Deno.KvEntryMaybe<T>[];
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

    const chunks = chunkImmutableItems([...uniqueItems.values()]);
    await mapWithConcurrency(
      chunks,
      MAX_READ_CONCURRENCY,
      (items) => this.putImmutableChunk(items, 0),
    );
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

function validateRevisionManifest(value: unknown): RevisionManifest {
  const record = recordValue(value, "revision manifest");
  if (record.encodingVersion !== "revision-v1") {
    throw new ArchiveCorruptError("Revision has an invalid encoding version");
  }
  const eventCount = boundedInteger(
    record.eventCount,
    "revision event count",
    0,
    MAX_ARCHIVE_EVENT_COUNT,
  );
  if (
    !Array.isArray(record.bucketHashes) || record.bucketHashes.length !== 256
  ) {
    throw new ArchiveCorruptError("Revision must contain 256 bucket hashes");
  }
  const bucketHashes = record.bucketHashes.map((hash) => {
    validateHash(hash, "bucket hash");
    return hash;
  });
  return { encodingVersion: "revision-v1", eventCount, bucketHashes };
}

function validateChangeSetManifest(value: unknown): ChangeSetManifest {
  const record = recordValue(value, "change-set manifest");
  if (record.encodingVersion !== "change-set-v1") {
    throw new ArchiveCorruptError("Change set has an invalid encoding version");
  }
  validateHash(record.previousRevisionHash, "previous revision hash");
  validateHash(record.revisionHash, "revision hash");
  const countsRecord = recordValue(record.counts, "change counts");
  const pageCountsRecord = recordValue(record.pageCounts, "change page counts");
  const counts: Record<ChangeKind, number> = {
    appeared: 0,
    disappeared: 0,
    updated: 0,
  };
  const pageCounts: Record<ChangeKind, number> = {
    appeared: 0,
    disappeared: 0,
    updated: 0,
  };
  for (const kind of changeKinds()) {
    counts[kind] = boundedInteger(
      countsRecord[kind],
      `${kind} change count`,
      0,
      MAX_ARCHIVE_EVENT_COUNT,
    );
    pageCounts[kind] = boundedInteger(
      pageCountsRecord[kind],
      `${kind} page count`,
      0,
      Math.ceil(MAX_ARCHIVE_EVENT_COUNT / CHANGE_PAGE_ITEMS),
    );
    if (pageCounts[kind] !== Math.ceil(counts[kind] / CHANGE_PAGE_ITEMS)) {
      throw new ArchiveCorruptError(`${kind} page count is inconsistent`);
    }
  }
  if (
    counts.appeared + counts.disappeared + counts.updated >
      2 * MAX_ARCHIVE_EVENT_COUNT
  ) {
    throw new ArchiveCorruptError("Change set contains too many events");
  }
  return {
    encodingVersion: "change-set-v1",
    previousRevisionHash: record.previousRevisionHash,
    revisionHash: record.revisionHash,
    counts,
    pageCounts,
  };
}

function validateChangePage(
  value: unknown,
  expectedKind: ChangeKind,
): StoredChangePage {
  const record = recordValue(value, "change page");
  if (
    record.encodingVersion !== "change-page-v1" ||
    record.kind !== expectedKind ||
    !Array.isArray(record.entries) || record.entries.length > CHANGE_PAGE_ITEMS
  ) {
    throw new ArchiveCorruptError(`Invalid ${expectedKind} change page`);
  }
  const entries = record.entries.map((value, index): ChangeReference => {
    const entry = recordValue(value, `${expectedKind} change ${index}`);
    const id = boundedInteger(entry.id, "change event ID", 1, 2_147_483_647);
    const beforeHash = nullableHash(entry.beforeHash, "before event hash");
    const afterHash = nullableHash(entry.afterHash, "after event hash");
    if (!Array.isArray(entry.changedFields)) {
      throw new ArchiveCorruptError("Change fields must be an array");
    }
    const changedFields = entry.changedFields.map((field) => {
      if (!isEventField(field)) {
        throw new ArchiveCorruptError("Change contains an invalid field");
      }
      return field;
    });
    if (new Set(changedFields).size !== changedFields.length) {
      throw new ArchiveCorruptError("Change contains duplicate fields");
    }
    const validShape = expectedKind === "appeared"
      ? beforeHash === null && afterHash !== null && changedFields.length === 0
      : expectedKind === "disappeared"
      ? beforeHash !== null && afterHash === null && changedFields.length === 0
      : beforeHash !== null && afterHash !== null;
    if (!validShape) {
      throw new ArchiveCorruptError(`Invalid ${expectedKind} change shape`);
    }
    return { id, beforeHash, afterHash, changedFields };
  });
  return { encodingVersion: "change-page-v1", kind: expectedKind, entries };
}

function validateObservationRecord(value: unknown, keyDate: string): void {
  const record = recordValue(value, "observation");
  const date = parseStoredDate(record.date, "observation date");
  if (date !== parseStoredDate(keyDate, "observation key date")) {
    throw new ArchiveCorruptError("Observation date does not match its key");
  }
  if (
    typeof record.fetchedAt !== "string" ||
    !isCanonicalDateTime(record.fetchedAt)
  ) {
    throw new ArchiveCorruptError("Observation has an invalid fetch timestamp");
  }
  validateHash(record.revisionHash, "observation revision hash");
  if (record.previousObservationDate !== null) {
    const previousDate = parseStoredDate(
      record.previousObservationDate,
      "previous observation date",
    );
    if (previousDate >= date) {
      throw new ArchiveCorruptError("Observation chronology is invalid");
    }
  }
  boundedInteger(
    record.eventCount,
    "observation event count",
    0,
    MAX_ARCHIVE_EVENT_COUNT,
  );
  if (
    record.sourceEtag !== null &&
    (typeof record.sourceEtag !== "string" ||
      new TextEncoder().encode(record.sourceEtag).byteLength > 1_024)
  ) {
    throw new ArchiveCorruptError("Observation has an invalid ETag");
  }
  if (typeof record.confirmedAnomaly !== "boolean") {
    throw new ArchiveCorruptError("Observation has an invalid anomaly flag");
  }
}

function validateHeadRecord(value: unknown): void {
  const record = recordValue(value, "archive head");
  const date = parseStoredDate(record.date, "head date");
  const firstDate = parseStoredDate(
    record.firstObservationDate,
    "first observation date",
  );
  if (firstDate > date) {
    throw new ArchiveCorruptError("Archive head dates are inconsistent");
  }
  validateHash(record.revisionHash, "head revision hash");
  boundedInteger(
    record.eventCount,
    "head event count",
    0,
    MAX_ARCHIVE_EVENT_COUNT,
  );
}

function validatePendingRecord(value: unknown): void {
  const record = recordValue(value, "pending candidate");
  parseStoredDate(record.firstSeenDate, "pending candidate date");
  validateHash(record.baseRevisionHash, "pending base revision hash");
  validateHash(record.candidateRevisionHash, "pending revision hash");
  validateHash(record.changeSetHash, "pending change-set hash");
  boundedInteger(
    record.eventCount,
    "pending event count",
    0,
    MAX_ARCHIVE_EVENT_COUNT,
  );
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ArchiveCorruptError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) || (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new ArchiveCorruptError(`${label} is outside its valid range`);
  }
  return value as number;
}

function validateHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new ArchiveCorruptError(`${label} is invalid`);
  }
}

function nullableHash(value: unknown, label: string): string | null {
  if (value === null) return null;
  validateHash(value, label);
  return value;
}

function parseStoredDate(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new ArchiveCorruptError(`${label} must be a string`);
  }
  try {
    return parseUtcDate(value);
  } catch {
    throw new ArchiveCorruptError(`${label} is invalid`);
  }
}

function isCanonicalDateTime(value: string): boolean {
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function isEventField(value: unknown): value is EventField {
  return typeof value === "string" && [
    "SLUG",
    "NAME",
    "SHORT_NAME",
    "LOCALISED_NAME",
    "LOCATION",
    "COORDINATES",
    "COUNTRY",
    "SERIES",
  ].includes(value);
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

function revisionIdKey(hash: string, id: number): Deno.KvKey {
  return [...REVISION_ID_PREFIX, hash, id];
}

function revisionIdIndexedKey(hash: string): Deno.KvKey {
  return [...REVISION_ID_INDEXED_PREFIX, hash];
}

function revisionCountriesKey(hash: string): Deno.KvKey {
  return [...REVISION_COUNTRIES_PREFIX, hash];
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
  input: {
    readonly id?: number | undefined;
    readonly slug?: string | undefined;
    readonly asOf: string;
  },
  observation: PublicObservation | null,
  event: EventRecord | null,
): EventLookupResult {
  return {
    status,
    requestedId: input.id ?? null,
    requestedSlug: input.slug ?? null,
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
    const comparison = compareSlugs(entry.slug, slug);
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
