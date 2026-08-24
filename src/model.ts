export const EVENT_ENCODING_VERSION = "event-v1";
export const BUCKET_ENCODING_VERSION = "bucket-v1";
export const REVISION_ENCODING_VERSION = "revision-v1";
export const BUCKET_COUNT = 256;

export type EventField =
  | "SLUG"
  | "NAME"
  | "SHORT_NAME"
  | "LOCALISED_NAME"
  | "LOCATION"
  | "COORDINATES"
  | "COUNTRY"
  | "SERIES";

export interface EventRecord {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
  readonly shortName: string;
  readonly localisedName: string | null;
  readonly location: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly countryCode: number;
  readonly countryUrl: string;
  readonly seriesId: number;
}

export interface HashedEvent {
  readonly event: EventRecord;
  readonly hash: string;
}

export interface BucketEntry {
  readonly slug: string;
  readonly id: number;
  readonly eventHash: string;
}

export interface RevisionBucket {
  readonly index: number;
  readonly hash: string;
  readonly entries: readonly BucketEntry[];
}

export interface RevisionManifest {
  readonly encodingVersion: typeof REVISION_ENCODING_VERSION;
  readonly eventCount: number;
  readonly bucketHashes: readonly string[];
}

export interface CatalogueRevision {
  readonly hash: string;
  readonly manifest: RevisionManifest;
  readonly bucketHashes: readonly string[];
  readonly buckets: readonly RevisionBucket[];
  readonly eventsById: ReadonlyMap<number, HashedEvent>;
}

export interface AppearedChange {
  readonly id: number;
  readonly afterHash: string;
}

export interface DisappearedChange {
  readonly id: number;
  readonly beforeHash: string;
}

export interface UpdatedChange {
  readonly id: number;
  readonly beforeHash: string;
  readonly afterHash: string;
  readonly changedFields: readonly EventField[];
}

export interface CatalogueDiff {
  readonly appeared: readonly AppearedChange[];
  readonly disappeared: readonly DisappearedChange[];
  readonly updated: readonly UpdatedChange[];
}

export function canonicalEventJson(event: EventRecord): string {
  return JSON.stringify([
    EVENT_ENCODING_VERSION,
    event.id,
    event.slug,
    event.name,
    event.shortName,
    event.localisedName,
    event.location,
    normalizeNegativeZero(event.latitude),
    normalizeNegativeZero(event.longitude),
    event.countryCode,
    event.countryUrl,
    event.seriesId,
  ]);
}

export function canonicalBucketJson(
  entries: readonly BucketEntry[],
): string {
  return JSON.stringify([
    BUCKET_ENCODING_VERSION,
    entries.map((entry) => [entry.slug, entry.id, entry.eventHash]),
  ]);
}

export function canonicalRevisionJson(manifest: RevisionManifest): string {
  return JSON.stringify([
    manifest.encodingVersion,
    manifest.eventCount,
    manifest.bucketHashes,
  ]);
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(bytes).buffer,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function bucketIndexForSlug(slug: string): Promise<number> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(slug),
  );
  return new Uint8Array(digest)[0]!;
}

export async function buildRevision(
  sourceEvents: readonly EventRecord[],
): Promise<CatalogueRevision> {
  const events = [...sourceEvents].sort((left, right) => left.id - right.id);
  assertUniqueEvents(events);

  const hashedEvents = await Promise.all(
    events.map(async (event): Promise<HashedEvent> => ({
      event,
      hash: await sha256Hex(canonicalEventJson(event)),
    })),
  );
  const eventsById = new Map(
    hashedEvents.map((hashed) => [hashed.event.id, hashed] as const),
  );

  const entriesByBucket = Array.from(
    { length: BUCKET_COUNT },
    (): BucketEntry[] => [],
  );
  await Promise.all(hashedEvents.map(async ({ event, hash }) => {
    const index = await bucketIndexForSlug(event.slug);
    entriesByBucket[index]!.push({
      slug: event.slug,
      id: event.id,
      eventHash: hash,
    });
  }));

  const buckets = await Promise.all(
    entriesByBucket.map(async (entries, index) => {
      entries.sort((left, right) => compareSlugs(left.slug, right.slug));
      return {
        index,
        entries,
        hash: await sha256Hex(canonicalBucketJson(entries)),
      } satisfies RevisionBucket;
    }),
  );
  const bucketHashes = buckets.map((bucket) => bucket.hash);
  const manifest: RevisionManifest = {
    encodingVersion: REVISION_ENCODING_VERSION,
    eventCount: events.length,
    bucketHashes,
  };

  return {
    hash: await sha256Hex(canonicalRevisionJson(manifest)),
    manifest,
    bucketHashes,
    buckets,
    eventsById,
  };
}

export function compareSlugs(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function diffRevisions(
  before: CatalogueRevision,
  after: CatalogueRevision,
): CatalogueDiff {
  const appeared: AppearedChange[] = [];
  const disappeared: DisappearedChange[] = [];
  const updated: UpdatedChange[] = [];
  const ids = new Set([
    ...before.eventsById.keys(),
    ...after.eventsById.keys(),
  ]);

  for (const id of [...ids].sort((left, right) => left - right)) {
    const previous = before.eventsById.get(id);
    const next = after.eventsById.get(id);
    if (previous === undefined && next !== undefined) {
      appeared.push({ id, afterHash: next.hash });
    } else if (previous !== undefined && next === undefined) {
      disappeared.push({ id, beforeHash: previous.hash });
    } else if (
      previous !== undefined && next !== undefined &&
      previous.hash !== next.hash
    ) {
      updated.push({
        id,
        beforeHash: previous.hash,
        afterHash: next.hash,
        changedFields: changedEventFields(previous.event, next.event),
      });
    }
  }

  return { appeared, disappeared, updated };
}

export function changedEventFields(
  before: EventRecord,
  after: EventRecord,
): readonly EventField[] {
  const fields: EventField[] = [];
  if (before.slug !== after.slug) fields.push("SLUG");
  if (before.name !== after.name) fields.push("NAME");
  if (before.shortName !== after.shortName) fields.push("SHORT_NAME");
  if (before.localisedName !== after.localisedName) {
    fields.push("LOCALISED_NAME");
  }
  if (before.location !== after.location) fields.push("LOCATION");
  if (
    before.latitude !== after.latitude || before.longitude !== after.longitude
  ) {
    fields.push("COORDINATES");
  }
  if (
    before.countryCode !== after.countryCode ||
    before.countryUrl !== after.countryUrl
  ) {
    fields.push("COUNTRY");
  }
  if (before.seriesId !== after.seriesId) fields.push("SERIES");
  return fields;
}

function normalizeNegativeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function assertUniqueEvents(events: readonly EventRecord[]): void {
  const ids = new Set<number>();
  const slugs = new Set<string>();
  for (const event of events) {
    if (ids.has(event.id)) {
      throw new Error(`Duplicate event ID ${event.id}`);
    }
    if (slugs.has(event.slug)) {
      throw new Error(`Duplicate event slug ${event.slug}`);
    }
    ids.add(event.id);
    slugs.add(event.slug);
  }
}
