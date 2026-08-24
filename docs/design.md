# parkrun events archive — design

## Goal

Build a small, read-only GraphQL service that remembers the public parkrun event
catalogue over time.

The service will run on Deno Deploy at `parkrun-events.vlcdn.dev`, fetch
`https://images.parkrun.com/events.json` every day, and store accepted
observations in Deno KV. It will answer:

- What metadata did a slug have as of a given UTC date?
- What did several slug/date pairs look like in one request?
- Which events appeared, disappeared, or changed between accepted observations?

History starts with the earliest accepted live observation or explicitly
imported full-catalogue snapshot. Historical states are never inferred from the
current feed.

## Non-goals

The first version will not store results, participants, attendance, country
bounds, or raw source documents. It will not expose mutations, an ingestion
endpoint, authentication, or a separate web application. GraphiQL is enough for
interactive use.

The archive records what the source showed when fetched. It does not claim when
a real-world event change took effect.

## Decisions already made

- Runtime: Deno, never Node.js.
- Server: `Deno.serve` with GraphQL Yoga's Fetch API handler.
- Database: Deno KV.
- Schedule: daily at 03:00 UTC.
- Retention: indefinite.
- Access: public and read-only for now.
- Canonical event identity: the feed's numeric feature ID.
- Query key: the slug that was active in the selected historical observation.
- Date behavior: latest accepted observation on or before the requested date.
- Batch behavior: up to 100 independent slug/date inputs; preserve input order
  and duplicates.
- Changes: chronological appeared, disappeared, and updated transitions, not
  only a net comparison.
- Anomalies: a large change must be confirmed by a later valid fetch before
  publication.
- Historical loading: only hash-pinned, dated copies of the complete source may
  be imported, in chronological order, through an offline operator command.
- Production domain: `parkrun-events.vlcdn.dev`.

## Source research

The current feed is a GeoJSON `FeatureCollection`. At the time of design it
contained 2,965 events with numeric IDs from 1 to 3,980. Each event has:

- `id`
- `properties.eventname`
- `EventLongName`
- `EventShortName`
- nullable `LocalisedEventLongName`
- `EventLocation`
- `countrycode`
- `seriesid`
- point coordinates in `[longitude, latitude]` order

The top-level country table maps country codes to host names and map bounds.
Only the host name is needed. The event URL can be derived as
`https://<country-host>/<slug>/`.

A review of 97 distinct Internet Archive snapshots from 2019-10-03 through
2026-08-23 found:

- no duplicate slugs within a snapshot;
- no observed slug reused by a different numeric ID;
- 46 numeric IDs that changed slug, such as ID 22 changing from `black-park` to
  `blackpark`.

This supports numeric ID as identity and slug as a snapshot-scoped index. It is
evidence, not an official uniqueness guarantee, so every ingestion still
validates both IDs and active slugs.

## Runtime shape

Keep the code small and separate pure decisions from I/O:

```text
src/
  model.ts             normalized event types and canonical encoding
  source.ts            fetch and validate events.json
  diff.ts              ID-based catalogue comparison and anomaly policy
  archive.ts           storage interface and shared result types
  kv_archive.ts        Deno KV implementation
  ingest.ts            ingestion state machine
  history_manifest.ts  validate dated snapshot manifests and source files
  history_loader.ts    append snapshots through the ingestion state machine
  history_cli.ts       validate-only and production loader orchestration
  graphql.ts           schema, resolvers, dates, cursors, query limits
  app.ts               HTTP handler composition and /health
  main.ts              open KV, register cron, start Deno.serve
scripts/
  load_historical_snapshots.ts  operator-only loader entrypoint
tests/
  fixtures/
  *_test.ts
docs/
  design.md
```

`main.ts` is the only module that starts processes. Tests call exported
functions and Yoga's Fetch handler directly.

Direct dependencies will be pinned in `deno.json`:

- `graphql-yoga` 5.x, tested with Deno before selection is finalized;
- `graphql` 16.x;
- Deno standard assertion utilities.

Deno-compatible npm packages are package distribution only; the runtime remains
Deno and the code must not import Node built-ins, Express adapters, `process`,
or `Buffer`.

## Public GraphQL contract

The intended schema is deliberately small:

```graphql
scalar Date
scalar DateTime

type Query {
  event(slug: String!, asOf: Date!): EventLookup!
  events(inputs: [EventLookupInput!]!): [EventLookup!]!
  catalogueChanges(
    from: Date
    through: Date
    first: Int = 20
    after: String
  ): CatalogueChangeConnection!
  archiveInfo: ArchiveInfo!
}

input EventLookupInput {
  slug: String!
  asOf: Date!
}

enum EventLookupStatus {
  FOUND
  NOT_FOUND
  NO_ARCHIVE_COVERAGE
}

type EventLookup {
  status: EventLookupStatus!
  requestedSlug: String!
  requestedDate: Date!
  observation: Observation
  event: Event
}

type Observation {
  date: Date!
  fetchedAt: DateTime!
}

type Event {
  id: Int!
  slug: String!
  name: String!
  shortName: String!
  localisedName: String
  location: String!
  latitude: Float!
  longitude: Float!
  countryCode: Int!
  countryUrl: String!
  seriesId: Int!
  url: String!
}

type ArchiveInfo {
  firstObservation: Observation
  latestObservation: Observation
  latestEventCount: Int
}

type CatalogueChangeConnection {
  nodes: [CatalogueChange!]!
  pageInfo: PageInfo!
}

type CatalogueChange {
  observation: Observation!
  previousObservation: Observation!
  counts: ChangeCounts!
  appeared(first: Int = 50, after: String): EventChangeConnection!
  disappeared(first: Int = 50, after: String): EventChangeConnection!
  updated(first: Int = 50, after: String): EventChangeConnection!
}

type ChangeCounts {
  appeared: Int!
  disappeared: Int!
  updated: Int!
}

type EventChangeConnection {
  nodes: [EventChange!]!
  pageInfo: PageInfo!
}

type EventChange {
  id: Int!
  before: Event
  after: Event
  changedFields: [EventField!]!
}

enum EventField {
  SLUG
  NAME
  SHORT_NAME
  LOCALISED_NAME
  LOCATION
  COORDINATES
  COUNTRY
  SERIES
}

type PageInfo {
  endCursor: String
  hasNextPage: Boolean!
}
```

Expected lookup combinations are:

| Status                | Observation | Event   |
| --------------------- | ----------- | ------- |
| `FOUND`               | present     | present |
| `NOT_FOUND`           | present     | null    |
| `NO_ARCHIVE_COVERAGE` | null        | null    |

Invalid dates, invalid cursors, oversized batches, and unavailable storage are
GraphQL errors. Normal historical absence remains typed data rather than an
error.

The first accepted observation is a baseline and has no change set. An accepted
observation with no differences is retained, proving the feed was checked that
day, but it does not appear in `catalogueChanges`.

### Date semantics

`Date` accepts only a real `YYYY-MM-DD` UTC calendar date. For a query date,
select the latest accepted observation whose observation date is less than or
equal to it.

A missed, invalid, or quarantined run creates no observation, so lookup
automatically falls back to the preceding good day. The returned observation
makes that fallback visible. A future date resolves to the latest accepted
observation.

After a slug rename, the old slug resolves before the rename and not after it.
The new slug resolves to the same numeric event ID from the rename onward.

### Batch semantics

`events` accepts between 1 and 100 inputs. Each item can use a different date.
Results have exactly the same length and order as the input, including duplicate
inputs.

The resolver groups equal dates and catalogue revisions internally, batches KV
point reads in groups of at most 10, and restores results by original input
index.

### Pagination

Outer change-set pages and inner change pages accept 1 through 100 items. Change
sets sort by observation date; changes within a set sort by numeric event ID.

Cursors are opaque, versioned base64url values containing the connection kind,
filter fingerprint, and last sort key. A cursor from one date range or change
kind is invalid for another. Cursor input length is bounded before decoding.

## Deno KV model

Deno KV is a good fit for this low-traffic, append-mostly archive, but its
limits rule out one atomic write for the whole feed:

- maximum encoded key: 2 KiB;
- maximum value: 64 KiB;
- `getMany`: 10 keys;
- atomic checks: 100;
- atomic mutations: 1,000;
- atomic total size: 800 KiB.

The design therefore stages immutable, content-addressed data and publishes it
with one small atomic marker.

### Normalized event versions

Normalize each retained event into a fixed-field object. Canonically encode it
with an explicit encoding version and hash it with SHA-256.

```text
["v1", "event", eventHash] -> normalized Event
```

The hash includes the numeric ID, slug, names, location, coordinates, country
code and URL, series ID, and encoding version. Unknown source fields, country
bounds, and raw JSON do not affect it.

### Catalogue buckets

A catalogue revision is a persistent hash-bucket map keyed by slug:

1. Hash the slug.
2. Use the first hash byte as one of 256 bucket numbers.
3. Store that bucket as a sorted array of `{ slug, id, eventHash }`.
4. Hash the canonical bucket value.

```text
["v1", "bucket", bucketHash] -> sorted bucket entries
```

A revision manifest stores the 256 bucket hashes in bucket order:

```text
["v1", "revision", revisionHash] -> {
  encodingVersion,
  eventCount,
  bucketHashes[256]
}
```

Unchanged buckets are reused across revisions. A normal event update writes one
new event version, one new bucket, and one new revision manifest. The manifest
remains comfortably below 64 KiB; code also enforces a 48 KiB safety ceiling on
every encoded KV value.

This is simpler than a Merkle tree, much smaller than copying thousands of slug
keys for every changed day, and faster to query than scanning temporal deltas.

### Observations and control state

```text
["v1", "observation", "YYYY-MM-DD"] -> {
  fetchedAt,
  revisionHash,
  previousObservationDate,
  eventCount,
  sourceEtag
}

["v1", "change-by-date", "YYYY-MM-DD"] -> changeSetHash
["v1", "change-set", changeSetHash]     -> counts and page count
["v1", "change-page", changeSetHash, kind, page] -> change references

["v1", "meta", "head"]    -> latest date and revision
["v1", "meta", "pending"] -> unconfirmed anomalous candidate
```

Event, bucket, revision, accepted observation, and accepted change-set records
are immutable. Head and the pending candidate are coordination state.

Change pages contain compact references to before and after event hashes, not
duplicated event objects. Pages are sized by encoded bytes and never exceed the
48 KiB safety ceiling.

No key in accepted history has a TTL.

## Ingestion algorithm

`Deno.cron("fetch-parkrun-events", "0 3 * * *", options, handler)` is registered
at module top level before `Deno.serve`. Configure bounded retry backoff because
cron failures are not retried by default.

Each run uses its UTC date as its idempotency key.

### 1. Check the observation date

Read the day's observation, archive head, and pending candidate with strong
consistency. If that date is already accepted, return successfully.

Deno prevents overlap for one cron definition. The final optimistic commit also
ensures that concurrent retries cannot publish two observations for one date. A
date older than the current head or pending anomaly is skipped, so delayed work
cannot move accepted or quarantined state backwards.

### 2. Fetch safely

Fetch only the configured HTTPS source with:

- an abort timeout;
- HTTP status validation;
- a decompressed response-size ceiling;
- no redirect to an unexpected host;
- selected response metadata; oversized ETags are discarded.

A network failure does not alter pending candidates or accepted history.
Throwing lets Deno cron apply its configured retry schedule.

### 3. Validate the complete feed

Reject the whole candidate if any rule fails:

- top-level countries and event `FeatureCollection` exist;
- between 1,000 and 100,000 events exist;
- every exposed integer is within GraphQL's signed `Int` range;
- every ID is unique and positive;
- every active slug is unique and matches the observed lowercase path-segment
  form;
- names and slugs are non-empty and reasonably bounded;
- location is a bounded string; the source permits an empty location;
- localized name is either a non-empty string or null;
- country and series references are valid;
- geometry is a point with two finite coordinates;
- longitude is within -180 through 180;
- latitude is within -90 through 90;
- every referenced country has a valid host name.

Map GeoJSON `[longitude, latitude]` to named fields. Normalize country hosts to
HTTPS. Rejecting one malformed record is safer than publishing a partial
catalogue that resembles mass disappearance.

### 4. Canonicalize and stage

Sort normalized events by numeric ID, calculate event hashes, build 256 sorted
slug buckets, and calculate the revision hash.

Write missing event versions and buckets idempotently. If a content-addressed
key already exists, verify its encoded bytes instead of overwriting different
content. Write the revision manifest only after all referenced data exists.

A crash here can leave unreachable immutable values, but readers cannot see a
partial revision.

### 5. Diff by numeric ID

Load the prior revision's 256 buckets in `getMany` groups of 10 and reconstruct
its ID map. Compare it with the candidate:

- ID only in candidate: `appeared`;
- ID only in previous revision: `disappeared`;
- ID in both with a different event hash: `updated`;
- unchanged ID and hash: no change.

A slug rename is one `updated` event. A metadata update counts once regardless
of how many fields changed. Arrays and pages sort by numeric ID, so source
ordering cannot create false changes.

### 6. Detect and confirm anomalies

For every non-baseline candidate:

```text
changed = appeared + disappeared + updated
anomalous = changed > 100 OR changed / previousEventCount > 0.10
```

Exactly 100 changes and exactly 10 percent are not anomalous unless the other
condition is exceeded.

An anomalous candidate is staged and stored as pending without publishing an
observation. The next successfully fetched and valid candidate confirms it when
all significant pending transitions persist:

- pending appearances remain present with the same numeric IDs;
- pending disappearances remain absent;
- pending updated event versions retain the pending values.

Unrelated small changes are allowed, avoiding permanent quarantine when normal
catalogue activity continues. A failed or malformed fetch neither confirms nor
clears the pending candidate.

If the next valid candidate confirms the anomaly, recompute the complete diff
against the still-published head and publish the confirming candidate. Its
effective observation date is the confirmation date, not the first quarantined
date.

If it does not confirm, discard the pending decision and evaluate the new
candidate normally. It can be published, or become a replacement pending
anomaly.

### 7. Publish atomically

After all immutable event, bucket, revision, and change-page data exists,
perform one small atomic operation that:

- checks the previously read head versionstamp;
- checks that the day's observation is absent;
- checks the pending-candidate versionstamp;
- creates the observation marker;
- creates the change-by-date index when the diff is nonempty;
- advances the head;
- clears the pending pointer.

If the optimistic commit loses a race, reread the head and recompute rather than
blindly retrying stale decisions.

Readers start only from accepted observation keys. Staged or quarantined
revisions are therefore never visible.

## Historical snapshot loading

The offline loader accepts a local JSON manifest and exact copies of the full
`events.json` document. It does not scrape, infer, merge, or repair history. A
manifest has this shape:

```json
{
  "formatVersion": 1,
  "sourceUrl": "https://images.parkrun.com/events.json",
  "snapshots": [
    {
      "date": "2024-01-01",
      "fetchedAt": "2024-01-01T03:00:00.000Z",
      "file": "2024-01-01.json",
      "sha256": "<64 lowercase hexadecimal characters>",
      "etag": null
    }
  ]
}
```

Dates must be strictly increasing, timestamps must fall on their UTC observation
date, paths must remain under the manifest directory, and every file must match
its declared SHA-256 digest. Each file goes through the same size, schema, ID,
slug, coordinate, country, and event-count validation as the live source.

`deno task history:load --manifest <path>` is validation-only. It checks every
file and prints its source digest, revision hash, and event count without
opening a database. Adding `--apply` requires a production Deno KV connector URL
and `DENO_KV_ACCESS_TOKEN`; tokens are never accepted as command arguments. The
command validates the complete set before opening production KV, then re-reads
and re-verifies each file while applying it.

Loading is append-only and restartable. An existing observation is skipped only
when its revision, count, timestamp, and ETag exactly match. The loader refuses
to insert a missing observation before the current head, so importing older
history requires an empty database or a new database that can replace the old
one after verification. Large changes use the same pending-confirmation policy
as live ingestion; a trailing unconfirmed anomaly fails the command unless the
operator explicitly allows it.

Disable production ingestion while loading to prevent the daily cron from
advancing the head past an imported date. Re-enable it only after archive
queries and the final head have been verified.

## Lookup algorithm

For one slug/date pair:

1. Strictly parse the UTC date.
2. Try the exact observation key.
3. If absent, reverse-list accepted observations through the requested date with
   `limit: 1`.
4. If none exists, return `NO_ARCHIVE_COVERAGE`.
5. Load the selected revision manifest.
6. Hash the slug, select its bucket, and binary-search the sorted entries.
7. If absent, return `NOT_FOUND` with the effective observation.
8. Load the referenced event version and return `FOUND`.

Use strong reads for observation roots and all root-reachable data. Validate
key/date, head, count, revision, change-set, page, and hash relationships before
returning data. Missing or inconsistent content is archive corruption and
becomes a service error, never a false `NOT_FOUND`.

For a batch, group requests by date, then revision, then bucket. Deduplicate
point reads, split every `getMany` into at most 10 keys, bound concurrent list
operations, and finally restore original positions.

## Failure behavior

| Failure                    | Public result                                     |
| -------------------------- | ------------------------------------------------- |
| Source timeout or non-2xx  | Existing history remains available                |
| Invalid JSON or schema     | Existing history remains available                |
| Duplicate ID or slug       | Candidate rejected                                |
| Unconfirmed mass change    | Candidate remains invisible                       |
| Crash during staging       | Unreachable staged values; no partial observation |
| Crash after publication    | Retry sees the already accepted date              |
| Atomic conflict            | Recompute against the new head                    |
| Missing reachable KV value | Service error; never `NOT_FOUND`                  |
| Missed day                 | Later as-of queries fall back visibly             |

Structured logs record the run date, outcome, counts, duration, and safe error
category. Logs never include entire source bodies or stack traces in public
responses.

## HTTP and query safeguards

- `/graphql` serves GraphQL and GraphiQL.
- `/health` is unauthenticated and reports process health plus latest accepted
  observation date.
- CORS permits public reads.
- GraphQL request bodies, lexer tokens, and structural depth are bounded.
- Batch and pagination arguments are bounded to 100.
- A cardinality-aware validation rule expands fragment spreads and limits
  expensive aliased lookup and nested pagination fields.
- Change-set and event-change loads are memoized within each request.
- One request can run at most eight archive operations concurrently.
- Unexpected errors are masked.
- There is no mutation or HTTP ingestion route.

Rate limiting and authentication are deferred. They can be added without
changing archive keys or lookup semantics.

## Testing strategy

Use `Deno.test` with pure fixtures and `Deno.openKv(":memory:")`. The default
suite never calls the live parkrun feed.

Required coverage:

- source parsing and country URL resolution;
- duplicate and malformed input rejection;
- coordinate order and range checks;
- stable canonical hashes despite source property or array order;
- appeared, disappeared, updated, rename, disappearance, and reappearance;
- anomaly boundaries at exactly/over 100 and exactly/over 10 percent;
- confirmation, rejection, failed intervening fetch, and replacement candidate;
- first observation and unchanged daily observation;
- as-of fallback before history, on missed days, and on future dates;
- historical old/new slug behavior;
- manifest chronology, path containment, hash verification, idempotent snapshot
  loading, conflict rejection, and anomaly confirmation during import;
- ordered batches of 1 and 100, independent dates, and duplicates;
- KV `getMany` chunking;
- crash injection before revision completion and before atomic publication;
- idempotent same-day retry and optimistic conflict handling;
- change-set and nested cursor pagination;
- GraphQL status/nullability and stable error codes;
- `/health` and an end-to-end GraphQL request through the Fetch handler.

One preflight task should run formatting checks, linting, type checking, and all
tests.

## Deployment and operations

1. Provision a Deno KV database in the current Deno Deploy dashboard.
2. Assign it to the application; `Deno.openKv()` then selects the timeline's
   database automatically.
3. Keep production ingestion disabled while loading any historical snapshots.
4. Run the loader in validation-only mode, review every digest/revision/count,
   then apply it through the production logical database connector.
5. Enable production ingestion. Branch timelines also register cron and have
   isolated databases, so non-production handlers should return immediately
   unless explicitly enabled.
6. Deploy and verify `/health`, archive coverage, and a GraphQL introspection
   request.
7. Connect `parkrun-events.vlcdn.dev` after the deployment is healthy.

Deno KV stores and transits data through the US. This archive contains public
event metadata, so no personal-data residency requirement is expected.

Indefinite retention still needs operational protection. Deno's current
documentation is unclear about managed-KV backup/PITR guarantees and total
database limits. Before relying on the archive long term, add a periodic export,
test restoration, and monitor storage growth. Deleting the KV database destroys
its history.

## Implementation order

1. Create Deno configuration, normalized source types, fixtures, and full-feed
   validation.
2. Add deterministic event encoding, bucket revisions, and ID-based diffs.
3. Implement the Deno KV archive with baseline publication and single as-of
   lookup.
4. Add ordered batch lookup and GraphQL integration.
5. Add change sets, cursor pagination, and anomaly confirmation.
6. Add cron composition, health reporting, structured logs, and deployment
   documentation.
7. Run the full preflight and a local ingestion/query smoke test.
8. Add the guarded manifest-based historical snapshot loader.

## References

- [Deno Deploy cron](https://docs.deno.com/deploy/reference/cron/)
- [Deno KV on current Deno Deploy](https://docs.deno.com/deploy/reference/deno_kv/)
- [Deno KV transactions and limits](https://docs.deno.com/deploy/kv/transactions/)
- [Deno KV operations](https://docs.deno.com/deploy/kv/operations/)
- [GraphQL Yoga with Deno](https://the-guild.dev/graphql/yoga-server/docs/integrations/integration-with-deno)
- [parkrun events catalogue](https://images.parkrun.com/events.json)
