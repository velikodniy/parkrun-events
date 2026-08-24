# parkrun events archive

A GraphQL API for looking up historical parkrun event metadata.

**Endpoint:** `https://parkrun-events.vlcdn.dev/graphql`

The archive records the public event catalogue once per day. It can answer what
an event looked like on a past date, even if that event later changed or
disappeared.

> This is an unofficial project and is not affiliated with or endorsed by
> parkrun.

## Try it

Open
[parkrun-events.vlcdn.dev/graphql](https://parkrun-events.vlcdn.dev/graphql) to
use GraphiQL, or send a GraphQL request with any HTTP client.

```sh
curl https://parkrun-events.vlcdn.dev/graphql \
  -H 'content-type: application/json' \
  --data '{"query":"{ archiveInfo { firstObservation { date } latestObservation { date } latestEventCount } }"}'
```

## Look up one event

```graphql
query EventOnDate {
  event(slug: "bushy", asOf: "2026-08-24") {
    status
    observation {
      date
      fetchedAt
    }
    event {
      id
      slug
      name
      shortName
      localisedName
      location
      latitude
      longitude
      countryCode
      countryUrl
      seriesId
      url
    }
  }
}
```

The API selects the latest successful observation on or before `asOf`. The
returned `observation.date` shows which catalogue day was actually used.

### Lookup statuses

- `FOUND` — the slug existed in the selected observation.
- `NOT_FOUND` — the date is covered, but the slug did not exist then.
- `NO_ARCHIVE_COVERAGE` — the requested date is earlier than the archive.

## Look up several events

Each item can use a different date. Results remain in the same order as the
inputs, including duplicates. A request can contain up to 100 items.

```graphql
query EventsOnDates($inputs: [EventLookupInput!]!) {
  events(inputs: $inputs) {
    status
    requestedSlug
    requestedDate
    observation {
      date
    }
    event {
      id
      slug
      name
      location
    }
  }
}
```

Variables:

```json
{
  "inputs": [
    { "slug": "bushy", "asOf": "2026-08-01" },
    { "slug": "wimbledon", "asOf": "2026-08-15" },
    { "slug": "old-event-slug", "asOf": "2027-01-01" }
  ]
}
```

## See what changed

`catalogueChanges` returns observed transitions in chronological order. It does
not hide an event that disappeared and later reappeared. Pass `countryCode` to
return only changes involving that country; omit it or pass `null` for all
countries. A move between countries appears under both.

```graphql
query RecentChanges($after: String, $countryCode: Int) {
  catalogueChanges(
    countryCode: $countryCode
    from: "2026-08-01"
    through: "2026-08-31"
    first: 20
    after: $after
  ) {
    nodes {
      observation {
        date
      }
      previousObservation {
        date
      }
      counts {
        appeared
        disappeared
        updated
      }
      confirmedAnomaly
      appeared(first: 50) {
        nodes {
          after {
            id
            slug
            name
          }
        }
      }
      disappeared(first: 50) {
        nodes {
          before {
            id
            slug
            name
          }
        }
      }
      updated(first: 50) {
        nodes {
          id
          changedFields
          before {
            slug
            name
            location
          }
          after {
            slug
            name
            location
          }
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
```

Pass `pageInfo.endCursor` back as `after` to read the next page. Appeared,
disappeared, and updated lists have their own `pageInfo` and cursors when a
change set is large.

`confirmedAnomaly` is true when an unusually large catalogue change was held
back until a later observation confirmed it.

## Follow one event

Numeric event IDs remain stable when slugs change. Use `eventChanges` to read
one event's complete chronological history without scanning every catalogue
change:

```graphql
query EventHistory($eventId: Int!, $after: String) {
  eventChanges(eventId: $eventId, first: 20, after: $after) {
    nodes {
      kind
      observation { date }
      previousObservation { date }
      changedFields
      before { slug name countryCode }
      after { slug name countryCode }
    }
    pageInfo { hasNextPage endCursor }
  }
}
```

## Date behavior

Dates use `YYYY-MM-DD` in UTC. Failed or rejected catalogue downloads do not
create empty history; queries automatically fall back to the latest earlier
successful observation.

History begins with the earliest accepted live observation or imported
full-catalogue snapshot. The archive never infers past states from current data,
so coverage before that date depends on trustworthy dated snapshots.
