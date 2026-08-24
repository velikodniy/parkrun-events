import type { EventRecord } from "./model.ts";

export const EVENTS_SOURCE_URL = "https://images.parkrun.com/events.json";
export const DEFAULT_MINIMUM_EVENT_COUNT = 1_000;
export const DEFAULT_MAX_SOURCE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_SOURCE_TIMEOUT_MS = 20_000;

const GRAPHQL_INT_MAX = 2_147_483_647;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const MAX_SOURCE_STRING_LENGTH = 256;

type SourceErrorCode =
  | "INVALID_SOURCE_DOCUMENT"
  | "INVALID_COUNTRY"
  | "INVALID_EVENT"
  | "INVALID_EVENT_COORDINATES"
  | "DUPLICATE_EVENT_ID"
  | "DUPLICATE_EVENT_SLUG"
  | "TOO_FEW_EVENTS"
  | "SOURCE_TOO_LARGE"
  | "INVALID_JSON"
  | "INVALID_CONTENT_TYPE"
  | "SOURCE_HTTP_ERROR"
  | "SOURCE_REDIRECTED";

export class SourceDataError extends Error {
  constructor(
    readonly code: SourceErrorCode,
    message: string,
    readonly path: string | null = null,
  ) {
    super(message);
    this.name = "SourceDataError";
  }
}

export interface ParseEventsOptions {
  readonly minimumEventCount?: number;
}

export interface FetchEventsOptions extends ParseEventsOptions {
  readonly url?: string;
  readonly timeoutMs?: number;
  readonly maximumBytes?: number;
  readonly fetcher?: typeof fetch;
}

export interface FetchedCatalogue {
  readonly events: readonly EventRecord[];
  readonly fetchedAt: string;
  readonly etag: string | null;
}

export function parseEventsDocument(
  input: unknown,
  options: ParseEventsOptions = {},
): readonly EventRecord[] {
  const root = expectRecord(input, "$", "INVALID_SOURCE_DOCUMENT");
  const countriesInput = expectRecord(
    root.countries,
    "$.countries",
    "INVALID_SOURCE_DOCUMENT",
  );
  const countries = parseCountries(countriesInput);
  const collection = expectRecord(
    root.events,
    "$.events",
    "INVALID_SOURCE_DOCUMENT",
  );
  if (collection.type !== "FeatureCollection") {
    throw dataError(
      "INVALID_SOURCE_DOCUMENT",
      "$.events.type",
      "Expected a GeoJSON FeatureCollection",
    );
  }
  const features = expectArray(
    collection.features,
    "$.events.features",
    "INVALID_SOURCE_DOCUMENT",
  );
  const minimum = options.minimumEventCount ?? DEFAULT_MINIMUM_EVENT_COUNT;
  if (features.length < minimum) {
    throw dataError(
      "TOO_FEW_EVENTS",
      "$.events.features",
      `Expected at least ${minimum} events, received ${features.length}`,
    );
  }

  const ids = new Set<number>();
  const slugs = new Set<string>();
  const events = features.map((feature, index) => {
    const event = parseFeature(feature, index, countries);
    if (ids.has(event.id)) {
      throw dataError(
        "DUPLICATE_EVENT_ID",
        `$.events.features[${index}].id`,
        `Duplicate event ID ${event.id}`,
      );
    }
    if (slugs.has(event.slug)) {
      throw dataError(
        "DUPLICATE_EVENT_SLUG",
        `$.events.features[${index}].properties.eventname`,
        `Duplicate event slug ${event.slug}`,
      );
    }
    ids.add(event.id);
    slugs.add(event.slug);
    return event;
  });

  return events.sort((left, right) => left.id - right.id);
}

export async function readJsonResponse(
  response: Response,
  maximumBytes = DEFAULT_MAX_SOURCE_BYTES,
): Promise<unknown> {
  const contentType = response.headers.get("content-type");
  if (contentType !== null && !contentType.toLowerCase().includes("json")) {
    throw new SourceDataError(
      "INVALID_CONTENT_TYPE",
      `Expected JSON content, received ${contentType}`,
    );
  }
  if (response.body === null) {
    throw new SourceDataError("INVALID_JSON", "Source response has no body");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("source body exceeds configured limit");
        throw new SourceDataError(
          "SOURCE_TOO_LARGE",
          `Source body exceeds ${maximumBytes} bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof SourceDataError) throw error;
    throw new SourceDataError("INVALID_JSON", "Source body is not valid JSON");
  }
}

export async function fetchEventsCatalogue(
  options: FetchEventsOptions = {},
): Promise<FetchedCatalogue> {
  const sourceUrl = new URL(options.url ?? EVENTS_SOURCE_URL);
  const timeoutMs = options.timeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS;
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(sourceUrl, {
    headers: {
      accept: "application/json",
      "cache-control": "no-cache",
    },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new SourceDataError(
      "SOURCE_HTTP_ERROR",
      `Source returned HTTP ${response.status}`,
    );
  }
  if (response.url !== "") {
    const finalUrl = new URL(response.url);
    if (finalUrl.origin !== sourceUrl.origin) {
      throw new SourceDataError(
        "SOURCE_REDIRECTED",
        `Source changed origin to ${finalUrl.origin}`,
      );
    }
  }

  const document = await readJsonResponse(
    response,
    options.maximumBytes ?? DEFAULT_MAX_SOURCE_BYTES,
  );
  return {
    events: parseEventsDocument(document, options),
    fetchedAt: new Date().toISOString(),
    etag: response.headers.get("etag"),
  };
}

function parseCountries(
  input: Record<string, unknown>,
): ReadonlyMap<number, string | null> {
  const countries = new Map<number, string | null>();
  for (const [rawCode, rawCountry] of Object.entries(input)) {
    const code = Number(rawCode);
    if (!Number.isSafeInteger(code) || code < 0) {
      throw dataError(
        "INVALID_COUNTRY",
        `$.countries.${rawCode}`,
        `Invalid country code ${rawCode}`,
      );
    }
    const country = expectRecord(
      rawCountry,
      `$.countries.${rawCode}`,
      "INVALID_COUNTRY",
    );
    if (country.url === null) {
      countries.set(code, null);
      continue;
    }
    const host = expectString(
      country.url,
      `$.countries.${rawCode}.url`,
      "INVALID_COUNTRY",
    ).toLowerCase();
    if (!HOST_PATTERN.test(host) || host.includes("..")) {
      throw dataError(
        "INVALID_COUNTRY",
        `$.countries.${rawCode}.url`,
        `Invalid country host ${host}`,
      );
    }
    countries.set(code, `https://${host}`);
  }
  return countries;
}

function parseFeature(
  input: unknown,
  index: number,
  countries: ReadonlyMap<number, string | null>,
): EventRecord {
  const path = `$.events.features[${index}]`;
  const feature = expectRecord(input, path, "INVALID_EVENT");
  if (feature.type !== "Feature") {
    throw dataError("INVALID_EVENT", `${path}.type`, "Expected Feature");
  }
  const id = expectInteger(feature.id, `${path}.id`, "INVALID_EVENT", 1);
  if (id > GRAPHQL_INT_MAX) {
    throw dataError(
      "INVALID_EVENT",
      `${path}.id`,
      `Event ID exceeds GraphQL Int range: ${id}`,
    );
  }
  const properties = expectRecord(
    feature.properties,
    `${path}.properties`,
    "INVALID_EVENT",
  );
  const slug = expectString(
    properties.eventname,
    `${path}.properties.eventname`,
    "INVALID_EVENT",
  );
  if (!SLUG_PATTERN.test(slug)) {
    throw dataError(
      "INVALID_EVENT",
      `${path}.properties.eventname`,
      `Invalid event slug ${slug}`,
    );
  }
  const countryCode = expectInteger(
    properties.countrycode,
    `${path}.properties.countrycode`,
    "INVALID_EVENT",
    0,
  );
  const countryUrl = countries.get(countryCode);
  if (countryUrl === undefined || countryUrl === null) {
    throw dataError(
      "INVALID_EVENT",
      `${path}.properties.countrycode`,
      `Event references country ${countryCode} without a URL`,
    );
  }

  const geometry = expectRecord(
    feature.geometry,
    `${path}.geometry`,
    "INVALID_EVENT_COORDINATES",
  );
  const coordinates = expectArray(
    geometry.coordinates,
    `${path}.geometry.coordinates`,
    "INVALID_EVENT_COORDINATES",
  );
  if (
    geometry.type !== "Point" || coordinates.length !== 2 ||
    typeof coordinates[0] !== "number" ||
    typeof coordinates[1] !== "number" ||
    !Number.isFinite(coordinates[0]) || !Number.isFinite(coordinates[1]) ||
    coordinates[0] < -180 || coordinates[0] > 180 ||
    coordinates[1] < -90 || coordinates[1] > 90
  ) {
    throw dataError(
      "INVALID_EVENT_COORDINATES",
      `${path}.geometry`,
      "Expected valid GeoJSON point coordinates",
    );
  }

  return {
    id,
    slug,
    name: expectString(
      properties.EventLongName,
      `${path}.properties.EventLongName`,
      "INVALID_EVENT",
    ),
    shortName: expectString(
      properties.EventShortName,
      `${path}.properties.EventShortName`,
      "INVALID_EVENT",
    ),
    localisedName: expectNullableString(
      properties.LocalisedEventLongName,
      `${path}.properties.LocalisedEventLongName`,
    ),
    location: expectString(
      properties.EventLocation,
      `${path}.properties.EventLocation`,
      "INVALID_EVENT",
      true,
    ),
    longitude: normalizeNegativeZero(coordinates[0]),
    latitude: normalizeNegativeZero(coordinates[1]),
    countryCode,
    countryUrl,
    seriesId: expectInteger(
      properties.seriesid,
      `${path}.properties.seriesid`,
      "INVALID_EVENT",
      1,
    ),
  };
}

function expectRecord(
  value: unknown,
  path: string,
  code: SourceErrorCode,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw dataError(code, path, "Expected an object");
  }
  return value as Record<string, unknown>;
}

function expectArray(
  value: unknown,
  path: string,
  code: SourceErrorCode,
): unknown[] {
  if (!Array.isArray(value)) {
    throw dataError(code, path, "Expected an array");
  }
  return value;
}

function expectString(
  value: unknown,
  path: string,
  code: SourceErrorCode,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" || (!allowEmpty && value.length === 0) ||
    value.length > MAX_SOURCE_STRING_LENGTH
  ) {
    throw dataError(
      code,
      path,
      allowEmpty
        ? "Expected a bounded string"
        : "Expected a bounded, non-empty string",
    );
  }
  return value;
}

function expectNullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return expectString(value, path, "INVALID_EVENT");
}

function expectInteger(
  value: unknown,
  path: string,
  code: SourceErrorCode,
  minimum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw dataError(
      code,
      path,
      `Expected an integer greater than or equal to ${minimum}`,
    );
  }
  return value as number;
}

function dataError(
  code: SourceErrorCode,
  path: string,
  message: string,
): SourceDataError {
  return new SourceDataError(code, `${path}: ${message}`, path);
}

function normalizeNegativeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}
