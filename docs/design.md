# parkrun events archive

## Purpose

This service keeps a dated archive of the public parkrun event catalogue. It
runs on Deno Deploy, reads `https://images.parkrun.com/events.json`, and stores
accepted observations in Deno KV.

The public GraphQL API answers:

- what metadata a slug had on a UTC date;
- several independent slug/date lookups in one ordered batch;
- which events appeared, disappeared, or changed over time;
- the complete change history for one numeric event ID.

History starts with the earliest trusted full-catalogue snapshot. The service
never labels current data as historical data and never infers missing history.

## Scope

The archive stores event metadata only. It does not store results, participants,
attendance, country bounds, or raw source documents.

The API is public and read-only. It has no mutations, ingestion endpoint,
authentication flow, or separate web application. GraphiQL is the interactive
client.

An observation records what the source showed when it was fetched. It does not
claim when a real-world change took effect.

## Core decisions

- Use Deno only: `Deno.serve`, `Deno.cron`, Deno KV, GraphQL Yoga, and
  GraphQL.js.
- Fetch the live source daily at 03:00 UTC.
- Retain accepted history indefinitely.
- Treat the source numeric ID as event identity.
- Treat slugs as observation-scoped query keys.
- Resolve a date to the latest accepted observation on or before that UTC date.
- Preserve batch input order and duplicates; allow at most 100 inputs.
- Return every accepted transition in chronological order.
- Quarantine large changes until a later valid fetch confirms them.
- Import only dated, hash-pinned copies of the complete source.
- Use `parkrun-events.vlcdn.dev` as the intended public domain.

Historic source research found slug changes attached to stable numeric IDs. It
found no duplicate active slugs or observed slug reuse across IDs. Ingestion
still validates both IDs and slugs because this is evidence, not a source
guarantee.

## Public behavior

### Event lookup

`event(slug, asOf)` returns one of three states:

- `FOUND`: an observation and event are present;
- `NOT_FOUND`: an observation is present but the slug is absent;
- `NO_ARCHIVE_COVERAGE`: no accepted observation exists on or before the date.

A future date resolves to the latest accepted observation. A missed, invalid, or
quarantined day falls back visibly to the preceding accepted observation.

After a rename, the old slug resolves only during its active period. The new
slug resolves to the same numeric ID from the rename onward.

### Batch lookup

`events(inputs)` accepts 1 through 100 independent slug/date pairs. Results
preserve input order, length, and duplicates.

The resolver groups repeated dates, revisions, and buckets, batches KV reads in
groups of at most 10, and restores the original order.

### Change queries

`catalogueChanges` returns non-empty accepted change dates. It supports optional
UTC date bounds, optional country filtering, and cursor pagination.

`eventChanges` returns the chronological history of one numeric event ID.

A country move appears in both countries: the old country sees the departure and
the new country sees the arrival. Global results contain the event once.

Outer and inner pages accept 1 through 100 items. Dates sort chronologically;
events within a date sort by numeric ID.

Cursors are opaque base64url values bound to their connection, filters, country,
projection, and last sort position. Invalid, oversized, rewound, or cross-scope
cursors are rejected.

### Dates and errors

Dates must be real UTC calendar dates in `YYYY-MM-DD` form.

Normal historical absence is typed data. Invalid inputs, unavailable storage,
and corrupt reachable records are GraphQL errors.

## Architecture

The main modules are:

```text
src/model.ts             normalized event model and canonical hashing
src/source.ts            source fetch and full-document validation
src/diff.ts              ID-based differences and anomaly rules
src/kv_archive.ts        canonical Deno KV archive
src/ingest.ts            ingestion state machine
src/change_views.ts      date, country, detail, and event-history views
src/change_feed.ts       compressed monthly catalogue feed
src/history_*.ts         guarded historical import
src/graphql.ts           schema, resolvers, cursors, and query limits
src/app.ts               GraphQL, GraphiQL, and health HTTP handling
src/main.ts              KV setup, cron registration, and server startup
```

`main.ts` is the only module that starts processes. Tests call exported
functions and the Fetch handler directly.

Canonical records are authoritative. Change views and the compressed feed are
derived, independently rebuildable data.

## Canonical storage

Each retained event is normalized to fixed fields and hashed. Catalogue
revisions reuse content-addressed event records and one of 256 slug buckets when
their content is unchanged.

An observation points to a complete revision. A change set points to
byte-bounded pages of appeared, disappeared, and updated event references.

Accepted observations and their reachable content are immutable. Only the
archive head and a pending anomaly pointer are mutable coordination state.

All values have a 48 KiB safety ceiling. Accepted history has no TTL.

Publication stages immutable content first. One small atomic commit then creates
the observation, adds its change-date index when needed, advances the head, and
updates pending state.

Readers begin from accepted observations only. Incomplete staging and
quarantined candidates are invisible.

## Query storage

The change views store:

- global and country summaries by date;
- complete byte-bounded detail pages;
- chronological occurrences by event ID;
- a publication watermark.

The compressed feed stores one global or country value per active month. A value
normally contains complete summaries and full before/after event data for that
month.

Payloads use compact tuples and gzip. The binary envelope contains a magic
marker, bounded decompressed length, and SHA-256 of the uncompressed JSON.

Inline values target 3,500 bytes, below the 4 KiB read-unit boundary. A larger
month uses a small directory and immutable compressed pages. Every value stays
below 48 KiB and each page expands to at most 64 KiB.

Mass-change dates split into ordered fragments. Publication writes all pages
before switching the month directory. The feed watermark advances only after all
months are complete.

Retries verify and reuse staged data. Concurrent synchronizers converge through
compare-and-set publication. Partial work remains hidden behind the watermark.

Daily ingestion publishes the canonical observation, then synchronizes the
change views and compressed feed. A no-change observation advances only their
watermarks.

The imported 2026 history produces 84 active monthly scope records using about
51 KiB. The January-through-August catalogue query needs about 11 estimated 4
KiB read units across two GraphQL pages.

## Ingestion

### Fetch and validate

Each cron run uses its UTC date as an idempotency key. It skips an already
accepted date and refuses to move the archive behind a newer head or pending
candidate.

The fetch has a timeout, response-size ceiling, status check, and redirect-host
check. Oversized ETags are discarded. A network failure changes no archive
state.

The complete candidate is rejected when any retained record is invalid.
Validation covers document shape, event count, integer range, unique positive
IDs, unique slugs, bounded text, country references, point geometry, and
coordinate ranges.

Rejecting one malformed event is safer than publishing a partial catalogue that
resembles mass disappearance.

### Canonicalize and compare

Events sort by numeric ID before hashing. Slug buckets and revision manifests
are deterministic and independent of source array order.

The candidate is compared with the previous accepted revision by numeric ID:

- only in the candidate: appeared;
- only in the previous revision: disappeared;
- in both with different hashes: updated;
- same ID and hash: unchanged.

A slug rename is one update. Changed fields are recorded for the API.

### Quarantine anomalies

A non-baseline candidate is anomalous when more than 100 events change or more
than 10 percent of the previous catalogue changes.

An anomalous candidate is staged but not published. A later valid candidate
confirms it only when all significant transitions persist. Unrelated ordinary
changes may coexist with confirmation.

A failed or malformed fetch neither confirms nor clears pending state. If the
next valid candidate does not confirm it, the pending decision is replaced by
evaluation of that candidate.

A confirmed anomaly is published on the confirmation date after recomputing the
complete difference from the still-published head.

### Publish

The final atomic commit checks the head, observation absence, and pending
pointer before publishing. A lost race causes a reread and recomputation, not a
blind retry.

A crash during staging can leave unreachable immutable values but cannot expose
a partial observation. A retry after publication recognizes the accepted date.

## Historical imports

The offline loader accepts a local manifest plus exact full-catalogue JSON
files. Each manifest entry includes its UTC date, fetch timestamp, relative
path, SHA-256 digest, and optional ETag.

Dates must be strictly increasing. Paths must stay below the manifest directory.
Every file must match its digest and pass the same source validation as a live
fetch.

`deno task history:load --manifest <path>` validates every file without opening
production KV.

Adding `--apply` requires `DENO_KV_URL` and `DENO_KV_ACCESS_TOKEN`. Credentials
are accepted only through the environment. The loader validates the complete set
before opening production and rechecks each file while applying.

Loading is append-only, idempotent, and restartable. Existing observations are
skipped only when all stored metadata matches. Conflicts and attempts to insert
before the current head are rejected.

The live cron must remain disabled during a historical load. A trailing
unconfirmed anomaly remains quarantined until a later snapshot confirms it.

## Resource and security limits

- Deno KV point-read batches contain at most 10 keys.
- Stored values stay below 48 KiB.
- Compressed feed pages expand to at most 64 KiB.
- GraphQL bodies, lexer tokens, structural depth, batches, and page sizes are
  bounded.
- A cardinality-aware rule limits aliases, fragments, and nested pagination
  work.
- One request runs at most eight archive operations concurrently.
- Repeated reads are memoized within a request.
- Unexpected errors are masked.
- The service has no mutation or HTTP ingestion route.

## Testing and operations

The test suite uses `Deno.test`, pure fixtures, and `Deno.openKv(":memory:")`.
It does not call the live parkrun source.

Coverage includes source rejection, stable hashing, all change kinds, renames,
anomaly boundaries and confirmation, historical lookup, ordered batches, import
safety, crash recovery, concurrent publication, cursor scope, compression
limits, corruption, and read-unit counts.

`deno task preflight` runs format checks, linting, type checking, and all tests.

Deployment steps are:

1. provision and attach Deno KV;
2. load and verify trusted historical snapshots with ingestion disabled;
3. build and verify derived change data;
4. enable ingestion and deploy;
5. smoke-test `/health`, GraphiQL, archive coverage, filters, history, and
   pagination;
6. connect `parkrun-events.vlcdn.dev` after the service is healthy.

The archive contains public event metadata. It still needs periodic export,
restoration tests, and storage monitoring because deleting the KV database
destroys its history.

## References

- [Deno Deploy cron](https://docs.deno.com/deploy/reference/cron/)
- [Deno KV](https://docs.deno.com/deploy/reference/deno_kv/)
- [Deno KV transactions and limits](https://docs.deno.com/deploy/kv/transactions/)
- [GraphQL Yoga with Deno](https://the-guild.dev/graphql/yoga-server/docs/integrations/integration-with-deno)
- [parkrun event catalogue](https://images.parkrun.com/events.json)
