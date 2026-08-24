import { assertEquals, assertExists } from "@std/assert";
import { getIntrospectionQuery } from "graphql";
import { createGraphqlServer } from "../src/graphql.ts";
import { KvArchive } from "../src/kv_archive.ts";
import { buildRevision, diffRevisions } from "../src/model.ts";
import type { EventRecord } from "../src/model.ts";

function event(id: number, slug: string): EventRecord {
  return {
    id,
    slug,
    name: `${slug} parkrun`,
    shortName: slug,
    localisedName: null,
    location: `${slug} park`,
    latitude: 51,
    longitude: -1,
    countryCode: 97,
    countryUrl: "https://www.parkrun.org.uk",
    seriesId: 1,
  };
}

async function publish(
  archive: KvArchive,
  events: readonly EventRecord[],
  date: string,
): Promise<void> {
  const revision = await buildRevision(events);
  const control = await archive.readControl(date);
  let changeSetHash: string | null = null;
  if (control.head.value !== null) {
    const previous = await archive.loadRevision(
      control.head.value.revisionHash,
    );
    changeSetHash = await archive.stageChangeSet(
      previous.hash,
      revision.hash,
      diffRevisions(previous, revision),
    );
  }
  await archive.stageRevision(revision);
  const committed = await archive.commitObservation(control, {
    date,
    fetchedAt: `${date}T03:00:00.000Z`,
    revisionHash: revision.hash,
    eventCount: revision.manifest.eventCount,
    sourceEtag: null,
    changeSetHash,
    confirmedAnomaly: false,
  });
  if (!committed) throw new Error("Test observation did not commit");
}

async function execute(
  server: ReturnType<typeof createGraphqlServer>,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await server.fetch(
    new Request("http://localhost/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    }),
  );
  return await response.json() as Record<string, unknown>;
}

Deno.test("GraphQL resolves single and ordered historical event lookups", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    await publish(archive, [event(1, "old-slug")], "2026-08-01");
    await publish(archive, [event(1, "new-slug")], "2026-08-02");
    const server = createGraphqlServer(archive);

    assertEquals(
      await execute(
        server,
        `
      query {
        event(slug: "new-slug", asOf: "2026-08-02") {
          status
          observation { date fetchedAt }
          event { id slug }
        }
        archiveInfo {
          latestObservation { date }
          latestEventCount
        }
      }
    `,
      ),
      {
        data: {
          event: {
            status: "FOUND",
            observation: {
              date: "2026-08-02",
              fetchedAt: "2026-08-02T03:00:00.000Z",
            },
            event: { id: 1, slug: "new-slug" },
          },
          archiveInfo: {
            latestObservation: { date: "2026-08-02" },
            latestEventCount: 1,
          },
        },
      },
    );

    assertEquals(
      await execute(
        server,
        `
      query Lookups($inputs: [EventLookupInput!]!) {
        events(inputs: $inputs) {
          status
          requestedSlug
          requestedDate
          observation { date }
          event { id slug url }
        }
      }
    `,
        {
          inputs: [
            { slug: "new-slug", asOf: "2026-08-02" },
            { slug: "old-slug", asOf: "2026-08-01" },
            { slug: "old-slug", asOf: "2026-08-02" },
            { slug: "old-slug", asOf: "2026-07-31" },
            { slug: "new-slug", asOf: "9999-12-31" },
          ],
        },
      ),
      {
        data: {
          events: [
            {
              status: "FOUND",
              requestedSlug: "new-slug",
              requestedDate: "2026-08-02",
              observation: { date: "2026-08-02" },
              event: {
                id: 1,
                slug: "new-slug",
                url: "https://www.parkrun.org.uk/new-slug/",
              },
            },
            {
              status: "FOUND",
              requestedSlug: "old-slug",
              requestedDate: "2026-08-01",
              observation: { date: "2026-08-01" },
              event: {
                id: 1,
                slug: "old-slug",
                url: "https://www.parkrun.org.uk/old-slug/",
              },
            },
            {
              status: "NOT_FOUND",
              requestedSlug: "old-slug",
              requestedDate: "2026-08-02",
              observation: { date: "2026-08-02" },
              event: null,
            },
            {
              status: "NO_ARCHIVE_COVERAGE",
              requestedSlug: "old-slug",
              requestedDate: "2026-07-31",
              observation: null,
              event: null,
            },
            {
              status: "FOUND",
              requestedSlug: "new-slug",
              requestedDate: "9999-12-31",
              observation: { date: "2026-08-02" },
              event: {
                id: 1,
                slug: "new-slug",
                url: "https://www.parkrun.org.uk/new-slug/",
              },
            },
          ],
        },
      },
    );
  } finally {
    kv.close();
  }
});

Deno.test("GraphQL exposes chronological updated event details", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    await publish(archive, [event(1, "old-slug")], "2026-08-01");
    await publish(archive, [event(1, "new-slug")], "2026-08-02");
    const server = createGraphqlServer(archive);

    assertEquals(
      await execute(
        server,
        `
      query {
        catalogueChanges(from: "2026-08-01", through: "2026-08-31") {
          nodes {
            observation { date }
            previousObservation { date }
            counts { appeared disappeared updated }
            confirmedAnomaly
            appeared { nodes { id } }
            disappeared { nodes { id } }
            updated {
              nodes { id before { slug } after { slug } changedFields }
              pageInfo { hasNextPage }
            }
          }
          pageInfo { hasNextPage }
        }
      }
    `,
      ),
      {
        data: {
          catalogueChanges: {
            nodes: [{
              observation: { date: "2026-08-02" },
              previousObservation: { date: "2026-08-01" },
              counts: { appeared: 0, disappeared: 0, updated: 1 },
              confirmedAnomaly: false,
              appeared: { nodes: [] },
              disappeared: { nodes: [] },
              updated: {
                nodes: [{
                  id: 1,
                  before: { slug: "old-slug" },
                  after: { slug: "new-slug" },
                  changedFields: ["SLUG", "NAME", "SHORT_NAME", "LOCATION"],
                }],
                pageInfo: { hasNextPage: false },
              },
            }],
            pageInfo: { hasNextPage: false },
          },
        },
      },
    );
  } finally {
    kv.close();
  }
});

Deno.test("GraphQL paginates event changes with a scoped cursor", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    await publish(archive, [event(1, "one"), event(2, "two")], "2026-08-01");
    await publish(
      archive,
      [event(1, "one-new"), event(2, "two-new")],
      "2026-08-02",
    );
    const server = createGraphqlServer(archive);
    const query = `
      query Changes($after: String) {
        catalogueChanges(first: 1) {
          nodes {
            updated(first: 1, after: $after) {
              nodes { id }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }
    `;

    const first = await execute(server, query);
    const firstUpdated = (((first.data as Record<string, unknown>)
      .catalogueChanges as Record<string, unknown>).nodes as Array<
        Record<string, unknown>
      >)[0]!.updated as Record<string, unknown>;
    assertEquals(firstUpdated.nodes, [{ id: 1 }]);
    const firstPage = firstUpdated.pageInfo as Record<string, unknown>;
    assertEquals(firstPage.hasNextPage, true);
    assertExists(firstPage.endCursor);

    const second = await execute(server, query, { after: firstPage.endCursor });
    const secondUpdated = (((second.data as Record<string, unknown>)
      .catalogueChanges as Record<string, unknown>).nodes as Array<
        Record<string, unknown>
      >)[0]!.updated as Record<string, unknown>;
    assertEquals(secondUpdated.nodes, [{ id: 2 }]);
    assertEquals(
      (secondUpdated.pageInfo as Record<string, unknown>).hasNextPage,
      false,
    );
  } finally {
    kv.close();
  }
});

Deno.test("GraphQL paginates change sets with an opaque cursor", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const archive = new KvArchive(kv);
    await publish(archive, [event(1, "one")], "2026-08-01");
    await publish(archive, [event(1, "two")], "2026-08-02");
    await publish(archive, [event(1, "three")], "2026-08-03");
    const server = createGraphqlServer(archive);
    const query = `
      query Changes($after: String) {
        catalogueChanges(first: 1, after: $after) {
          nodes { observation { date } }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;

    const first = await execute(server, query);
    const firstConnection = (first.data as Record<string, unknown>)
      .catalogueChanges as Record<string, unknown>;
    assertEquals(firstConnection.nodes, [{
      observation: { date: "2026-08-02" },
    }]);
    const firstPageInfo = firstConnection.pageInfo as Record<string, unknown>;
    assertEquals(firstPageInfo.hasNextPage, true);
    assertExists(firstPageInfo.endCursor);

    const second = await execute(server, query, {
      after: firstPageInfo.endCursor,
    });
    const secondConnection = (second.data as Record<string, unknown>)
      .catalogueChanges as Record<string, unknown>;
    assertEquals(secondConnection.nodes, [{
      observation: { date: "2026-08-03" },
    }]);
    const secondPageInfo = secondConnection.pageInfo as Record<string, unknown>;
    assertEquals(secondPageInfo.hasNextPage, false);
    assertExists(secondPageInfo.endCursor);
  } finally {
    kv.close();
  }
});

Deno.test("GraphQL supports standard schema introspection", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const result = await execute(
      createGraphqlServer(new KvArchive(kv)),
      getIntrospectionQuery(),
    );
    assertEquals(result.errors, undefined);
    assertExists(result.data);
  } finally {
    kv.close();
  }
});

Deno.test("GraphQL rejects invalid dates and oversized batches", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const server = createGraphqlServer(new KvArchive(kv));
    const invalidDate = await execute(
      server,
      `
      query { event(slug: "bushy", asOf: "2026-02-30") { status } }
    `,
    );
    const invalidErrors = invalidDate.errors as Array<Record<string, unknown>>;
    assertExists(invalidErrors);
    assertEquals(
      (invalidErrors[0]!.extensions as Record<string, unknown>).code,
      "BAD_USER_INPUT",
    );

    const oversized = await execute(
      server,
      `
      query Batch($inputs: [EventLookupInput!]!) {
        events(inputs: $inputs) { status }
      }
    `,
      {
        inputs: Array.from({ length: 101 }, () => ({
          slug: "bushy",
          asOf: "2026-08-01",
        })),
      },
    );
    const oversizedErrors = oversized.errors as Array<Record<string, unknown>>;
    assertEquals(
      (oversizedErrors[0]!.extensions as Record<string, unknown>).code,
      "BATCH_LIMIT_EXCEEDED",
    );

    const maximumFanout = await execute(
      server,
      `
      query {
        catalogueChanges(first: 100) {
          nodes {
            appeared(first: 100) { nodes { id } }
            disappeared(first: 100) { nodes { id } }
            updated(first: 100) { nodes { id } }
          }
        }
      }
    `,
    );
    const fanoutErrors = maximumFanout.errors as Array<Record<string, unknown>>;
    assertEquals(
      (fanoutErrors[0]!.extensions as Record<string, unknown>).code,
      "QUERY_TOO_COMPLEX",
    );

    const aliases = Array.from(
      { length: 201 },
      (_, index) => `a${index}: archiveInfo { latestEventCount }`,
    ).join(" ");
    const excessiveDocument = await execute(server, `{ ${aliases} }`);
    const documentErrors = excessiveDocument.errors as Array<
      Record<string, unknown>
    >;
    assertEquals(
      (documentErrors[0]!.extensions as Record<string, unknown>).code,
      "QUERY_TOO_COMPLEX",
    );

    const expensiveAliases = Array.from(
      { length: 6 },
      (_, index) =>
        `c${index}: catalogueChanges(first: 100) { nodes { updated(first: 100) { nodes { id } } } }`,
    ).join(" ");
    const expensiveDocument = await execute(server, `{ ${expensiveAliases} }`);
    const expensiveErrors = expensiveDocument.errors as Array<
      Record<string, unknown>
    >;
    assertEquals(
      (expensiveErrors[0]!.extensions as Record<string, unknown>).code,
      "QUERY_TOO_COMPLEX",
    );

    const deepInlineQuery = `{ ${
      "... {".repeat(100)
    } archiveInfo { latestEventCount } ${"}".repeat(100)} }`;
    const deepInline = await execute(server, deepInlineQuery);
    const deepInlineErrors = deepInline.errors as Array<
      Record<string, unknown>
    >;
    assertEquals(
      (deepInlineErrors[0]!.extensions as Record<string, unknown>).code,
      "QUERY_TOO_COMPLEX",
    );

    const fragmentChain = [
      "query { ...F0 }",
      ...Array.from(
        { length: 70 },
        (_, index) =>
          index === 69
            ? `fragment F${index} on Query { archiveInfo { latestEventCount } }`
            : `fragment F${index} on Query { ...F${index + 1} }`,
      ),
    ].join("\n");
    const deepFragments = await execute(server, fragmentChain);
    const deepFragmentErrors = deepFragments.errors as Array<
      Record<string, unknown>
    >;
    assertEquals(
      (deepFragmentErrors[0]!.extensions as Record<string, unknown>).code,
      "QUERY_TOO_COMPLEX",
    );

    const fragmentReuse = await execute(
      server,
      `
      query {
        first: catalogueChanges(first: 100) { nodes { ...ExpensiveChanges } }
        second: catalogueChanges(first: 100) { nodes { ...ExpensiveChanges } }
        third: catalogueChanges(first: 100) { nodes { ...ExpensiveChanges } }
      }
      fragment ExpensiveChanges on CatalogueChange {
        appeared(first: 100) { nodes { id } }
      }
    `,
    );
    const fragmentErrors = fragmentReuse.errors as Array<
      Record<string, unknown>
    >;
    assertEquals(
      (fragmentErrors[0]!.extensions as Record<string, unknown>).code,
      "QUERY_TOO_COMPLEX",
    );
  } finally {
    kv.close();
  }
});
