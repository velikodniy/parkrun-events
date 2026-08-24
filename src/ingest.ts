import type {
  ArchiveControl,
  PendingCandidate,
  PublishObservationInput,
} from "./archive.ts";
import { parseUtcDate } from "./date.ts";
import {
  anomalyRequiresConfirmation,
  changedEventCount,
  confirmsPendingChanges,
} from "./diff.ts";
import { KvArchive } from "./kv_archive.ts";
import { buildRevision, diffRevisions } from "./model.ts";
import type { CatalogueDiff, CatalogueRevision } from "./model.ts";
import type { FetchedCatalogue } from "./source.ts";

export type CatalogueFetcher = () => Promise<FetchedCatalogue>;

export type IngestionOutcome =
  | {
    readonly status: "ACCEPTED";
    readonly date: string;
    readonly eventCount: number;
    readonly changeCount: number;
    readonly confirmedAnomaly: boolean;
  }
  | {
    readonly status: "PENDING_CONFIRMATION";
    readonly date: string;
    readonly eventCount: number;
    readonly changeCount: number;
  }
  | {
    readonly status: "ALREADY_ACCEPTED";
    readonly date: string;
    readonly eventCount: number;
  }
  | {
    readonly status: "SKIPPED_OUT_OF_ORDER";
    readonly date: string;
    readonly latestDate: string;
  };

export class IngestionService {
  constructor(
    private readonly archive: KvArchive,
    private readonly fetchCatalogue: CatalogueFetcher,
  ) {}

  async run(dateInput: string): Promise<IngestionOutcome> {
    const date = parseUtcDate(dateInput);
    const initialControl = await this.archive.readControl(date);
    if (initialControl.observation.value !== null) {
      return {
        status: "ALREADY_ACCEPTED",
        date,
        eventCount: initialControl.observation.value.eventCount,
      };
    }
    if (initialControl.pending.value?.firstSeenDate === date) {
      return await this.pendingOutcome(initialControl.pending.value);
    }
    const initialLaterDate = latestControlDateAtOrAfter(initialControl, date);
    if (initialLaterDate !== null) {
      return outOfOrderOutcome(date, initialLaterDate);
    }

    const fetched = await this.fetchCatalogue();
    const candidate = await buildRevision(fetched.events);
    await this.archive.stageRevision(candidate);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const control = await this.archive.readControl(date);
      if (control.observation.value !== null) {
        return {
          status: "ALREADY_ACCEPTED",
          date,
          eventCount: control.observation.value.eventCount,
        };
      }
      if (control.pending.value?.firstSeenDate === date) {
        return await this.pendingOutcome(control.pending.value);
      }
      const laterDate = latestControlDateAtOrAfter(control, date);
      if (laterDate !== null) {
        return outOfOrderOutcome(date, laterDate);
      }

      if (control.head.value === null) {
        const committed = await this.archive.commitObservation(control, {
          date,
          fetchedAt: fetched.fetchedAt,
          revisionHash: candidate.hash,
          eventCount: candidate.manifest.eventCount,
          sourceEtag: fetched.etag,
          changeSetHash: null,
          confirmedAnomaly: false,
        });
        if (committed) {
          return acceptedOutcome(date, candidate, emptyDiff(), false);
        }
        continue;
      }

      const previous = await this.archive.loadRevision(
        control.head.value.revisionHash,
      );
      const diff = diffRevisions(previous, candidate);
      const pending = control.pending.value;
      if (pending !== null && pending.baseRevisionHash !== previous.hash) {
        throw new Error(
          "Pending anomaly baseline does not match the archive head",
        );
      }
      if (pending !== null && await this.confirms(pending, candidate)) {
        if (
          await this.publish(
            control,
            date,
            fetched,
            previous,
            candidate,
            diff,
            true,
          )
        ) {
          return acceptedOutcome(date, candidate, diff, true);
        }
        continue;
      }

      if (anomalyRequiresConfirmation(diff, previous.manifest.eventCount)) {
        const changeSetHash = await this.archive.stageChangeSet(
          previous.hash,
          candidate.hash,
          diff,
        );
        const nextPending: PendingCandidate = {
          firstSeenDate: date,
          baseRevisionHash: previous.hash,
          candidateRevisionHash: candidate.hash,
          changeSetHash,
          eventCount: candidate.manifest.eventCount,
        };
        if (await this.archive.commitPending(control, nextPending)) {
          return {
            status: "PENDING_CONFIRMATION",
            date,
            eventCount: candidate.manifest.eventCount,
            changeCount: changedEventCount(diff),
          };
        }
        continue;
      }

      if (
        await this.publish(
          control,
          date,
          fetched,
          previous,
          candidate,
          diff,
          false,
        )
      ) {
        return acceptedOutcome(date, candidate, diff, false);
      }
    }

    throw new Error("Ingestion control state changed repeatedly");
  }

  private async confirms(
    pending: PendingCandidate,
    candidate: CatalogueRevision,
  ): Promise<boolean> {
    const pendingChangeSet = await this.archive.loadChangeSet(
      pending.changeSetHash,
    );
    if (
      pendingChangeSet.manifest.previousRevisionHash !==
        pending.baseRevisionHash ||
      pendingChangeSet.manifest.revisionHash !== pending.candidateRevisionHash
    ) {
      throw new Error("Pending anomaly does not match its stored change set");
    }
    return confirmsPendingChanges(
      pendingChangeSet.diff,
      candidate.eventsById,
    );
  }

  private async publish(
    control: ArchiveControl,
    date: string,
    fetched: FetchedCatalogue,
    previous: CatalogueRevision,
    candidate: CatalogueRevision,
    diff: CatalogueDiff,
    confirmedAnomaly: boolean,
  ): Promise<boolean> {
    const changeSetHash = changedEventCount(diff) === 0
      ? null
      : await this.archive.stageChangeSet(previous.hash, candidate.hash, diff);
    const input: PublishObservationInput = {
      date,
      fetchedAt: fetched.fetchedAt,
      revisionHash: candidate.hash,
      eventCount: candidate.manifest.eventCount,
      sourceEtag: fetched.etag,
      changeSetHash,
      confirmedAnomaly,
    };
    return await this.archive.commitObservation(control, input);
  }

  private async pendingOutcome(
    pending: PendingCandidate,
  ): Promise<IngestionOutcome> {
    const changeSet = await this.archive.loadChangeSet(pending.changeSetHash);
    return {
      status: "PENDING_CONFIRMATION",
      date: pending.firstSeenDate,
      eventCount: pending.eventCount,
      changeCount: changedEventCount(changeSet.diff),
    };
  }
}

function acceptedOutcome(
  date: string,
  revision: CatalogueRevision,
  diff: CatalogueDiff,
  confirmedAnomaly: boolean,
): IngestionOutcome {
  return {
    status: "ACCEPTED",
    date,
    eventCount: revision.manifest.eventCount,
    changeCount: changedEventCount(diff),
    confirmedAnomaly,
  };
}

function latestControlDateAtOrAfter(
  control: ArchiveControl,
  date: string,
): string | null {
  const latestDate = [
    control.head.value?.date,
    control.pending.value?.firstSeenDate,
  ].filter((value): value is string => value !== undefined)
    .sort()
    .at(-1);
  return latestDate !== undefined && date <= latestDate ? latestDate : null;
}

function outOfOrderOutcome(
  date: string,
  latestDate: string,
): IngestionOutcome {
  return {
    status: "SKIPPED_OUT_OF_ORDER",
    date,
    latestDate,
  };
}

function emptyDiff(): CatalogueDiff {
  return { appeared: [], disappeared: [], updated: [] };
}
