import type { UtcDate } from "./date.ts";
import type { CatalogueDiff, EventField, EventRecord } from "./model.ts";

export interface ObservationRecord {
  readonly date: UtcDate;
  readonly fetchedAt: string;
  readonly revisionHash: string;
  readonly previousObservationDate: UtcDate | null;
  readonly eventCount: number;
  readonly sourceEtag: string | null;
  readonly confirmedAnomaly: boolean;
}

export interface PublicObservation {
  readonly date: UtcDate;
  readonly fetchedAt: string;
}

export interface ArchiveHead {
  readonly date: UtcDate;
  readonly revisionHash: string;
  readonly eventCount: number;
  readonly firstObservationDate: UtcDate;
}

export interface PendingCandidate {
  readonly firstSeenDate: UtcDate;
  readonly baseRevisionHash: string;
  readonly candidateRevisionHash: string;
  readonly changeSetHash: string;
  readonly eventCount: number;
}

export interface ArchiveControl {
  readonly head: Deno.KvEntryMaybe<ArchiveHead>;
  readonly pending: Deno.KvEntryMaybe<PendingCandidate>;
  readonly observation: Deno.KvEntryMaybe<ObservationRecord>;
}

export interface PublishObservationInput {
  readonly date: UtcDate;
  readonly fetchedAt: string;
  readonly revisionHash: string;
  readonly eventCount: number;
  readonly sourceEtag: string | null;
  readonly changeSetHash: string | null;
  readonly confirmedAnomaly: boolean;
}

export interface EventLookupInput {
  readonly slug: string;
  readonly asOf: UtcDate;
}

export type EventLookupStatus =
  | "FOUND"
  | "NOT_FOUND"
  | "NO_ARCHIVE_COVERAGE";

export interface EventLookupResult {
  readonly status: EventLookupStatus;
  readonly requestedSlug: string;
  readonly requestedDate: UtcDate;
  readonly observation: PublicObservation | null;
  readonly event: EventRecord | null;
}

export interface ChangeReference {
  readonly id: number;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly changedFields: readonly EventField[];
}

export type ChangeKind = "appeared" | "disappeared" | "updated";

export interface ChangeSetManifest {
  readonly encodingVersion: "change-set-v1";
  readonly previousRevisionHash: string;
  readonly revisionHash: string;
  readonly counts: Readonly<Record<ChangeKind, number>>;
  readonly pageCounts: Readonly<Record<ChangeKind, number>>;
}

export interface StoredChangeSet {
  readonly hash: string;
  readonly manifest: ChangeSetManifest;
  readonly diff: CatalogueDiff;
}

export interface ArchiveInfo {
  readonly firstObservation: PublicObservation | null;
  readonly latestObservation: PublicObservation | null;
  readonly latestEventCount: number | null;
}
