import type { ArchiveControl, ObservationRecord } from "./archive.ts";
import { parseUtcDate, utcDateOf } from "./date.ts";
import type {
  HistoricalSnapshot,
  HistoricalSnapshotManifestEntry,
} from "./history_manifest.ts";
import { type IngestionOutcome, IngestionService } from "./ingest.ts";
import { KvArchive } from "./kv_archive.ts";
import { buildRevision } from "./model.ts";
import type { CatalogueRevision } from "./model.ts";

export type HistoricalSnapshotReader = (
  entry: HistoricalSnapshotManifestEntry,
) => Promise<HistoricalSnapshot>;

export interface HistoricalSnapshotLoadOptions {
  readonly today?: string;
}

export interface HistoricalSnapshotLoadRow {
  readonly date: string;
  readonly sourceSha256: string;
  readonly outcome: IngestionOutcome;
}

export interface HistoricalSnapshotLoadReport {
  readonly rows: readonly HistoricalSnapshotLoadRow[];
  readonly pendingDate: string | null;
}

export class HistoricalSnapshotConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoricalSnapshotConflictError";
  }
}

export class HistoricalSnapshotLoader {
  constructor(private readonly archive: KvArchive) {}

  async load(
    entries: readonly HistoricalSnapshotManifestEntry[],
    readSnapshot: HistoricalSnapshotReader,
    options: HistoricalSnapshotLoadOptions = {},
  ): Promise<HistoricalSnapshotLoadReport> {
    if (entries.length < 1) {
      throw new RangeError(
        "Historical snapshot load requires at least one entry",
      );
    }
    const today = parseUtcDate(options.today ?? utcDateOf(new Date()));
    validateEntryOrder(entries, today);

    const rows: HistoricalSnapshotLoadRow[] = [];
    for (const entry of entries) {
      const snapshot = await readSnapshot(entry);
      assertSnapshotMatchesEntry(snapshot, entry);
      const candidate = await buildRevision(snapshot.events);
      const control = await this.archive.readControl(entry.date);
      const existing = control.observation.value;
      if (existing !== null) {
        assertObservationMatchesSnapshot(existing, candidate, snapshot);
        rows.push({
          date: entry.date,
          sourceSha256: snapshot.sourceSha256,
          outcome: {
            status: "ALREADY_ACCEPTED",
            date: entry.date,
            eventCount: existing.eventCount,
          },
        });
        continue;
      }
      assertCanAppendSnapshot(control, candidate, snapshot);

      const ingestion = new IngestionService(
        this.archive,
        () =>
          Promise.resolve({
            events: snapshot.events,
            fetchedAt: snapshot.fetchedAt,
            etag: snapshot.etag,
          }),
      );
      const outcome = await ingestion.run(entry.date);
      await this.assertOutcomeMatchesSnapshot(outcome, candidate, snapshot);
      rows.push({
        date: entry.date,
        sourceSha256: snapshot.sourceSha256,
        outcome,
      });
    }

    const finalControl = await this.archive.readControl(entries.at(-1)!.date);
    return {
      rows,
      pendingDate: finalControl.pending.value?.firstSeenDate ?? null,
    };
  }

  private async assertOutcomeMatchesSnapshot(
    outcome: IngestionOutcome,
    candidate: CatalogueRevision,
    snapshot: HistoricalSnapshot,
  ): Promise<void> {
    if (outcome.status === "SKIPPED_OUT_OF_ORDER") {
      throw new HistoricalSnapshotConflictError(
        `Snapshot ${snapshot.date} cannot follow observation ${outcome.latestDate}`,
      );
    }
    const control = await this.archive.readControl(snapshot.date);
    if (
      outcome.status === "PENDING_CONFIRMATION"
    ) {
      const pending = control.pending.value;
      if (
        pending === null || pending.firstSeenDate !== snapshot.date ||
        pending.candidateRevisionHash !== candidate.hash ||
        pending.eventCount !== candidate.manifest.eventCount
      ) {
        throw new HistoricalSnapshotConflictError(
          `Pending snapshot ${snapshot.date} does not match its source`,
        );
      }
      return;
    }
    const observation = control.observation.value;
    if (observation === null) {
      throw new HistoricalSnapshotConflictError(
        `Snapshot ${snapshot.date} was not published`,
      );
    }
    assertObservationMatchesSnapshot(observation, candidate, snapshot);
  }
}

function validateEntryOrder(
  entries: readonly HistoricalSnapshotManifestEntry[],
  today: string,
): void {
  for (let index = 0; index < entries.length; index += 1) {
    const date = parseUtcDate(entries[index]!.date);
    if (date > today) {
      throw new RangeError(`Historical snapshot ${date} is in the future`);
    }
    if (index > 0 && entries[index - 1]!.date >= date) {
      throw new RangeError(
        "Historical snapshot dates must be strictly increasing",
      );
    }
  }
}

function assertSnapshotMatchesEntry(
  snapshot: HistoricalSnapshot,
  entry: HistoricalSnapshotManifestEntry,
): void {
  if (
    snapshot.date !== entry.date || snapshot.fetchedAt !== entry.fetchedAt ||
    snapshot.file !== entry.file || snapshot.sha256 !== entry.sha256 ||
    snapshot.sourceSha256 !== entry.sha256 || snapshot.etag !== entry.etag
  ) {
    throw new HistoricalSnapshotConflictError(
      `Snapshot reader returned unexpected metadata for ${entry.date}`,
    );
  }
}

function assertCanAppendSnapshot(
  control: ArchiveControl,
  candidate: CatalogueRevision,
  snapshot: HistoricalSnapshot,
): void {
  const head = control.head.value;
  if (head !== null && head.date >= snapshot.date) {
    throw new HistoricalSnapshotConflictError(
      `Snapshot ${snapshot.date} cannot insert before archive head ${head.date}`,
    );
  }
  const pending = control.pending.value;
  if (pending !== null && pending.firstSeenDate === snapshot.date) {
    if (
      pending.candidateRevisionHash !== candidate.hash ||
      pending.eventCount !== candidate.manifest.eventCount
    ) {
      throw new HistoricalSnapshotConflictError(
        `Snapshot ${snapshot.date} does not match its pending candidate`,
      );
    }
  } else if (pending !== null && pending.firstSeenDate > snapshot.date) {
    throw new HistoricalSnapshotConflictError(
      `Snapshot ${snapshot.date} cannot insert before pending candidate ${pending.firstSeenDate}`,
    );
  }
}

function assertObservationMatchesSnapshot(
  observation: ObservationRecord,
  candidate: CatalogueRevision,
  snapshot: HistoricalSnapshot,
): void {
  if (
    observation.revisionHash !== candidate.hash ||
    observation.eventCount !== candidate.manifest.eventCount ||
    observation.fetchedAt !== snapshot.fetchedAt ||
    observation.sourceEtag !== snapshot.etag
  ) {
    throw new HistoricalSnapshotConflictError(
      `Accepted observation ${snapshot.date} does not match its snapshot`,
    );
  }
}
