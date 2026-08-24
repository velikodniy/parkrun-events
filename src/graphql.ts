import {
  GraphQLError,
  GraphQLScalarType,
  Kind,
  Lexer,
  Source,
  TokenKind,
} from "graphql";
import type {
  ASTVisitor,
  DocumentNode,
  FieldNode,
  FragmentDefinitionNode,
  SelectionSetNode,
  ValidationContext,
  ValidationRule,
} from "graphql";
import { createSchema, createYoga } from "graphql-yoga";
import type {
  CatalogueChangeSummary,
  ChangeKind,
  EventChangePage,
  EventLookupInput,
  StoredChangeSet,
} from "./archive.ts";
import {
  ChangeReadModel,
  type ViewCatalogueChangeSummary,
  type ViewEventChangePosition,
} from "./change_views.ts";
import { Semaphore } from "./concurrency.ts";
import { parseUtcDate } from "./date.ts";
import { KvArchive } from "./kv_archive.ts";

const QUERY_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_CURSOR_LENGTH = 1_024;
const MAX_DOCUMENT_FIELDS = 250;
const MAX_OPERATION_COST = 50_000;
const MAX_REQUEST_ARCHIVE_CONCURRENCY = 8;
const MAX_SOURCE_TOKENS = 5_000;
const MAX_SOURCE_DEPTH = 64;
const MAX_SELECTION_DEPTH = 64;

const typeDefs = /* GraphQL */ `
  scalar Date
  scalar DateTime

  type Query {
    event(slug: String!, asOf: Date!): EventLookup!
    events(inputs: [EventLookupInput!]!): [EventLookup!]!
    catalogueChanges(
      countryCode: Int = null
      from: Date
      through: Date
      first: Int = 20
      after: String
    ): CatalogueChangeConnection!
    eventChanges(
      eventId: Int!
      from: Date
      through: Date
      first: Int = 20
      after: String
    ): EventChangeHistoryConnection!
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
    confirmedAnomaly: Boolean!
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

  type EventChangeHistoryConnection {
    nodes: [EventChangeHistory!]!
    pageInfo: PageInfo!
  }

  type EventChangeHistory {
    kind: EventChangeKind!
    observation: Observation!
    previousObservation: Observation!
    before: Event
    after: Event
    changedFields: [EventField!]!
    confirmedAnomaly: Boolean!
  }

  enum EventChangeKind {
    APPEARED
    DISAPPEARED
    UPDATED
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
`;

const dateScalar = new GraphQLScalarType({
  name: "Date",
  description: "A UTC calendar date in YYYY-MM-DD format.",
  serialize: coerceDate,
  parseValue: coerceDate,
  parseLiteral(node) {
    if (node.kind !== Kind.STRING) throw badDate();
    return coerceDate(node.value);
  },
});

const dateTimeScalar = new GraphQLScalarType({
  name: "DateTime",
  description: "An ISO 8601 UTC timestamp.",
  serialize(value) {
    if (typeof value !== "string" || !isIsoDateTime(value)) {
      throw new GraphQLError("Invalid DateTime value");
    }
    return value;
  },
});

interface CatalogueChangesArguments {
  readonly countryCode?: number | null;
  readonly from?: string | null;
  readonly through?: string | null;
  readonly first: number;
  readonly after?: string | null;
}

interface EventChangesArguments {
  readonly first: number;
  readonly after?: string | null;
}

interface EventHistoryArguments {
  readonly eventId: number;
  readonly from?: string | null;
  readonly through?: string | null;
  readonly first: number;
  readonly after?: string | null;
}

interface ChangeSetCursor {
  readonly version: 2;
  readonly connection: "catalogue-changes";
  readonly from: string | null;
  readonly through: string | null;
  readonly countryCode: number | null;
  readonly lastDate: string;
}

interface GraphqlContext {
  readonly archiveSemaphore: Semaphore;
  readonly changeSets: Map<string, Promise<StoredChangeSet>>;
  readonly eventChangePages: Map<string, Promise<EventChangePage>>;
}

interface EventChangeCursor {
  readonly version: 1;
  readonly connection: "event-changes";
  readonly changeSetHash: string;
  readonly kind: ChangeKind;
  readonly lastId: number;
}

interface ViewEventChangeCursor {
  readonly version: 2;
  readonly connection: "event-changes";
  readonly changeSetHash: string;
  readonly kind: ChangeKind;
  readonly page: number;
  readonly offset: number;
  readonly lastId: number;
}

interface EventHistoryCursor {
  readonly version: 1;
  readonly connection: "event-history";
  readonly eventId: number;
  readonly from: string | null;
  readonly through: string | null;
  readonly lastDate: string;
}

export function createGraphqlServer(
  archive: KvArchive,
  changeViews?: ChangeReadModel,
) {
  const resolveEventChanges = async (
    parent: CatalogueChangeSummary,
    arguments_: EventChangesArguments,
    kind: ChangeKind,
    context: GraphqlContext,
  ) => {
    validatePageSize(arguments_.first);
    const after = arguments_.after === undefined || arguments_.after === null
      ? undefined
      : decodeEventChangeCursor(arguments_.after, parent.hash, kind);
    const pageKey = JSON.stringify([
      parent.hash,
      isViewSummary(parent) ? parent.viewCountryCode : "canonical",
      kind,
      arguments_.first,
      after ?? null,
    ]);
    let pagePromise = context.eventChangePages.get(pageKey);
    if (pagePromise === undefined) {
      pagePromise = context.archiveSemaphore.run(async () => {
        if (isViewSummary(parent)) {
          if (changeViews === undefined) {
            throw new Error("Materialized change view is unavailable");
          }
          return await changeViews.getEventChanges(parent, kind, {
            first: arguments_.first,
            ...(after?.position === undefined ? {} : { after: after.position }),
          });
        }
        let changeSetPromise = context.changeSets.get(parent.hash);
        if (changeSetPromise === undefined) {
          changeSetPromise = archive.loadChangeSet(parent.hash);
          context.changeSets.set(parent.hash, changeSetPromise);
        }
        const changeSet = await changeSetPromise;
        return await archive.getEventChanges(parent.hash, kind, {
          first: arguments_.first,
          ...(after === undefined ? {} : { afterId: after.lastId }),
          changeSet,
        });
      });
      context.eventChangePages.set(pageKey, pagePromise);
    }
    const page = await pagePromise;
    const viewPosition = "endPosition" in page
      ? page.endPosition as ViewEventChangePosition | null
      : null;
    return {
      nodes: page.nodes,
      pageInfo: {
        hasNextPage: page.hasNextPage,
        endCursor: page.endId === null ? null : encodeCursor(
          viewPosition === null
            ? {
              version: 1,
              connection: "event-changes",
              changeSetHash: parent.hash,
              kind,
              lastId: page.endId,
            } satisfies EventChangeCursor
            : {
              version: 2,
              connection: "event-changes",
              changeSetHash: parent.hash,
              kind,
              ...viewPosition,
            } satisfies ViewEventChangeCursor,
        ),
      },
    };
  };

  const schema = createSchema({
    typeDefs,
    resolvers: {
      Date: dateScalar,
      DateTime: dateTimeScalar,
      Query: {
        event: async (
          _parent: unknown,
          arguments_: { readonly slug: string; readonly asOf: string },
          context: GraphqlContext,
        ) => {
          const input = normalizeLookupInput({
            slug: arguments_.slug,
            asOf: arguments_.asOf,
          });
          return await context.archiveSemaphore.run(async () =>
            (await archive.lookupMany([input]))[0]!
          );
        },
        events: async (
          _parent: unknown,
          arguments_: { readonly inputs: readonly EventLookupInput[] },
          context: GraphqlContext,
        ) => {
          if (arguments_.inputs.length < 1 || arguments_.inputs.length > 100) {
            throw new GraphQLError(
              "Event lookup batch must contain 1 through 100 inputs",
              {
                extensions: {
                  code: "BATCH_LIMIT_EXCEEDED",
                  maximum: 100,
                  actual: arguments_.inputs.length,
                },
              },
            );
          }
          return await context.archiveSemaphore.run(() =>
            archive.lookupMany(arguments_.inputs.map(normalizeLookupInput))
          );
        },
        catalogueChanges: async (
          _parent: unknown,
          arguments_: CatalogueChangesArguments,
          context: GraphqlContext,
        ) => {
          validatePageSize(arguments_.first);
          const countryCode = arguments_.countryCode ?? null;
          const from = arguments_.from ?? null;
          const through = arguments_.through ?? null;
          const afterDate = arguments_.after === undefined ||
              arguments_.after === null
            ? undefined
            : decodeChangeSetCursor(
              arguments_.after,
              countryCode,
              from,
              through,
            );
          const page = await context.archiveSemaphore.run(() =>
            changeViews === undefined
              ? countryCode === null
                ? archive.listCatalogueChanges({
                  first: arguments_.first,
                  ...(from === null ? {} : { from }),
                  ...(through === null ? {} : { through }),
                  ...(afterDate === undefined ? {} : { afterDate }),
                })
                : Promise.reject(
                  new GraphQLError("Country filtering is not available", {
                    extensions: { code: "CHANGE_VIEW_NOT_READY" },
                  }),
                )
              : changeViews.listCatalogueChanges({
                first: arguments_.first,
                ...(countryCode === null ? {} : { countryCode }),
                ...(from === null ? {} : { from }),
                ...(through === null ? {} : { through }),
                ...(afterDate === undefined ? {} : { afterDate }),
              })
          );
          return {
            nodes: page.nodes,
            pageInfo: {
              hasNextPage: page.hasNextPage,
              endCursor: page.endDate === null ? null : encodeCursor(
                {
                  version: 2,
                  connection: "catalogue-changes",
                  countryCode,
                  from,
                  through,
                  lastDate: page.endDate,
                } satisfies ChangeSetCursor,
              ),
            },
          };
        },
        eventChanges: async (
          _parent: unknown,
          arguments_: EventHistoryArguments,
          context: GraphqlContext,
        ) => {
          validatePageSize(arguments_.first);
          if (changeViews === undefined) {
            throw new GraphQLError("Event history is not available", {
              extensions: { code: "CHANGE_VIEW_NOT_READY" },
            });
          }
          const from = arguments_.from ?? null;
          const through = arguments_.through ?? null;
          const afterDate = arguments_.after === undefined ||
              arguments_.after === null
            ? undefined
            : decodeEventHistoryCursor(
              arguments_.after,
              arguments_.eventId,
              from,
              through,
            );
          const page = await context.archiveSemaphore.run(() =>
            changeViews.listEventChanges({
              eventId: arguments_.eventId,
              first: arguments_.first,
              ...(from === null ? {} : { from }),
              ...(through === null ? {} : { through }),
              ...(afterDate === undefined ? {} : { afterDate }),
            })
          );
          return {
            nodes: page.nodes,
            pageInfo: {
              hasNextPage: page.hasNextPage,
              endCursor: page.endDate === null ? null : encodeCursor(
                {
                  version: 1,
                  connection: "event-history",
                  eventId: arguments_.eventId,
                  from,
                  through,
                  lastDate: page.endDate,
                } satisfies EventHistoryCursor,
              ),
            },
          };
        },
        archiveInfo: (
          _parent: unknown,
          _arguments: Record<string, never>,
          context: GraphqlContext,
        ) => context.archiveSemaphore.run(() => archive.getArchiveInfo()),
      },
      CatalogueChange: {
        appeared: (
          parent: CatalogueChangeSummary,
          arguments_: EventChangesArguments,
          context: GraphqlContext,
        ) => resolveEventChanges(parent, arguments_, "appeared", context),
        disappeared: (
          parent: CatalogueChangeSummary,
          arguments_: EventChangesArguments,
          context: GraphqlContext,
        ) => resolveEventChanges(parent, arguments_, "disappeared", context),
        updated: (
          parent: CatalogueChangeSummary,
          arguments_: EventChangesArguments,
          context: GraphqlContext,
        ) => resolveEventChanges(parent, arguments_, "updated", context),
      },
      EventChangeKind: {
        APPEARED: "appeared",
        DISAPPEARED: "disappeared",
        UPDATED: "updated",
      },
      Event: {
        url: (event: { readonly countryUrl: string; readonly slug: string }) =>
          `${event.countryUrl}/${event.slug}/`,
      },
    },
  });

  return createYoga({
    schema,
    context: (): GraphqlContext => ({
      archiveSemaphore: new Semaphore(MAX_REQUEST_ARCHIVE_CONCURRENCY),
      changeSets: new Map(),
      eventChangePages: new Map(),
    }),
    plugins: [sourceLimitsPlugin(), operationLimitsPlugin()],
    graphqlEndpoint: "/graphql",
    graphiql: true,
    cors: { origin: "*" },
    maskedErrors: true,
    logging: false,
  });
}

function sourceLimitsPlugin() {
  return {
    onParse({
      params,
    }: {
      readonly params: { readonly source: string | Source };
    }) {
      const lexer = new Lexer(
        typeof params.source === "string"
          ? new Source(params.source)
          : params.source,
      );
      let tokens = 0;
      let depth = 0;
      while (true) {
        const token = lexer.advance();
        if (token.kind === TokenKind.EOF) break;
        tokens += 1;
        if (
          token.kind === TokenKind.BRACE_L ||
          token.kind === TokenKind.BRACKET_L ||
          token.kind === TokenKind.PAREN_L
        ) {
          depth += 1;
        } else if (
          token.kind === TokenKind.BRACE_R ||
          token.kind === TokenKind.BRACKET_R ||
          token.kind === TokenKind.PAREN_R
        ) {
          depth -= 1;
        }
        if (tokens > MAX_SOURCE_TOKENS || depth > MAX_SOURCE_DEPTH) {
          throw new GraphQLError("GraphQL operation is too complex", {
            extensions: {
              code: "QUERY_TOO_COMPLEX",
              maximumTokens: MAX_SOURCE_TOKENS,
              maximumDepth: MAX_SOURCE_DEPTH,
            },
          });
        }
      }
    },
  };
}

function operationLimitsPlugin() {
  return {
    onValidate({
      addValidationRule,
    }: {
      readonly addValidationRule: (rule: ValidationRule) => void;
    }) {
      addValidationRule(documentFieldLimitRule);
    },
  };
}

function documentFieldLimitRule(context: ValidationContext): ASTVisitor {
  return {
    Document(document: DocumentNode) {
      const fragments = new Map<string, FragmentDefinitionNode>();
      for (const definition of document.definitions) {
        if (definition.kind === Kind.FRAGMENT_DEFINITION) {
          fragments.set(definition.name.value, definition);
        }
      }
      for (const definition of document.definitions) {
        if (definition.kind !== Kind.OPERATION_DEFINITION) continue;
        const complexity = selectionSetComplexity(
          definition.selectionSet,
          fragments,
          new Set(),
          1,
          0,
        );
        if (
          complexity.fields > MAX_DOCUMENT_FIELDS ||
          complexity.cost > MAX_OPERATION_COST
        ) {
          context.reportError(
            new GraphQLError("GraphQL operation is too complex", {
              nodes: definition,
              extensions: {
                code: "QUERY_TOO_COMPLEX",
                maximumFields: MAX_DOCUMENT_FIELDS,
                maximumCost: MAX_OPERATION_COST,
              },
            }),
          );
          break;
        }
      }
    },
  };
}

function selectionSetComplexity(
  selectionSet: SelectionSetNode,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  fragmentStack: ReadonlySet<string>,
  multiplier: number,
  depth: number,
): { readonly fields: number; readonly cost: number } {
  if (depth > MAX_SELECTION_DEPTH) {
    return { fields: MAX_DOCUMENT_FIELDS + 1, cost: MAX_OPERATION_COST + 1 };
  }
  let fields = 0;
  let cost = 0;
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      fields += 1;
      cost += multiplier;
      if (selection.selectionSet !== undefined) {
        const nested = selectionSetComplexity(
          selection.selectionSet,
          fragments,
          fragmentStack,
          multiplier * fieldCardinality(selection),
          depth + 1,
        );
        fields += nested.fields;
        cost += nested.cost;
      }
      continue;
    }
    if (selection.kind === Kind.INLINE_FRAGMENT) {
      const nested = selectionSetComplexity(
        selection.selectionSet,
        fragments,
        fragmentStack,
        multiplier,
        depth + 1,
      );
      fields += nested.fields;
      cost += nested.cost;
      continue;
    }

    const name = selection.name.value;
    const fragment = fragments.get(name);
    if (fragment === undefined || fragmentStack.has(name)) continue;
    const nextStack = new Set(fragmentStack);
    nextStack.add(name);
    const nested = selectionSetComplexity(
      fragment.selectionSet,
      fragments,
      nextStack,
      multiplier,
      depth + 1,
    );
    fields += nested.fields;
    cost += nested.cost;
  }
  return { fields, cost };
}

function fieldCardinality(field: FieldNode): number {
  if (field.name.value === "events") {
    const inputs = field.arguments?.find((argument) =>
      argument.name.value === "inputs"
    )?.value;
    return inputs?.kind === Kind.LIST
      ? Math.min(inputs.values.length, 100)
      : 100;
  }

  const defaults: Readonly<Record<string, number>> = {
    catalogueChanges: 20,
    appeared: 50,
    disappeared: 50,
    updated: 50,
  };
  const defaultValue = defaults[field.name.value];
  if (defaultValue === undefined) return 1;
  const first = field.arguments?.find((argument) =>
    argument.name.value === "first"
  )?.value;
  if (first === undefined) return defaultValue;
  if (first.kind !== Kind.INT) return 100;
  return Math.min(Math.max(Number(first.value), 1), 100);
}

function normalizeLookupInput(input: EventLookupInput): EventLookupInput {
  const slug = input.slug.trim().toLowerCase();
  if (!QUERY_SLUG_PATTERN.test(slug) || slug.length > 128) {
    throw new GraphQLError("Invalid event slug", {
      extensions: { code: "BAD_USER_INPUT", field: "slug" },
    });
  }
  return { slug, asOf: parseUtcDate(input.asOf) };
}

function coerceDate(value: unknown): string {
  if (typeof value !== "string") throw badDate();
  try {
    return parseUtcDate(value);
  } catch {
    throw badDate();
  }
}

function badDate(): GraphQLError {
  return new GraphQLError("Date must be a real UTC date in YYYY-MM-DD format", {
    extensions: { code: "BAD_USER_INPUT", field: "date" },
  });
}

function isIsoDateTime(value: string): boolean {
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function validatePageSize(first: number): void {
  if (!Number.isInteger(first) || first < 1 || first > 100) {
    throw new GraphQLError("Page size must be between 1 and 100", {
      extensions: { code: "BAD_USER_INPUT", field: "first" },
    });
  }
}

function encodeCursor(
  value:
    | ChangeSetCursor
    | EventChangeCursor
    | ViewEventChangeCursor
    | EventHistoryCursor,
): string {
  return btoa(JSON.stringify(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeChangeSetCursor(
  cursor: string,
  countryCode: number | null,
  from: string | null,
  through: string | null,
): string {
  const value = decodeCursor(cursor);
  const compatibleV1 = value.version === 1 && countryCode === null;
  const compatibleV2 = value.version === 2 &&
    value.countryCode === countryCode;
  if (
    value.connection !== "catalogue-changes" ||
    (!compatibleV1 && !compatibleV2) || value.from !== from ||
    value.through !== through || typeof value.lastDate !== "string"
  ) {
    throw invalidCursor();
  }
  try {
    return parseUtcDate(value.lastDate);
  } catch {
    throw invalidCursor();
  }
}

function decodeEventChangeCursor(
  cursor: string,
  changeSetHash: string,
  kind: ChangeKind,
): { readonly lastId: number; readonly position?: ViewEventChangePosition } {
  const value = decodeCursor(cursor);
  if (
    value.connection !== "event-changes" ||
    value.changeSetHash !== changeSetHash || value.kind !== kind ||
    !Number.isSafeInteger(value.lastId) || (value.lastId as number) < 0
  ) {
    throw invalidCursor();
  }
  if (value.version === 1) return { lastId: value.lastId as number };
  if (
    value.version !== 2 || !Number.isSafeInteger(value.page) ||
    (value.page as number) < 0 || !Number.isSafeInteger(value.offset) ||
    (value.offset as number) < 0
  ) {
    throw invalidCursor();
  }
  return {
    lastId: value.lastId as number,
    position: {
      page: value.page as number,
      offset: value.offset as number,
      lastId: value.lastId as number,
    },
  };
}

function decodeEventHistoryCursor(
  cursor: string,
  eventId: number,
  from: string | null,
  through: string | null,
): string {
  const value = decodeCursor(cursor);
  if (
    value.version !== 1 || value.connection !== "event-history" ||
    value.eventId !== eventId || value.from !== from ||
    value.through !== through || typeof value.lastDate !== "string"
  ) {
    throw invalidCursor();
  }
  try {
    return parseUtcDate(value.lastDate);
  } catch {
    throw invalidCursor();
  }
}

function isViewSummary(
  value: CatalogueChangeSummary,
): value is ViewCatalogueChangeSummary {
  return "viewPageCounts" in value && "viewCountryCode" in value;
}

function decodeCursor(cursor: string): Record<string, unknown> {
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) {
    throw invalidCursor();
  }
  try {
    const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const padding = "=".repeat((4 - base64.length % 4) % 4);
    const value = JSON.parse(atob(base64 + padding)) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError("Cursor payload is not an object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw invalidCursor();
  }
}

function invalidCursor(): GraphQLError {
  return new GraphQLError("Invalid or incompatible pagination cursor", {
    extensions: { code: "INVALID_CURSOR" },
  });
}
