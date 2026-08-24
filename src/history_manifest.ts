import { dirname, isAbsolute, relative, resolve, SEPARATOR } from "@std/path";
import { parseUtcDate } from "./date.ts";
import { sha256Hex } from "./model.ts";
import type { EventRecord } from "./model.ts";
import {
  DEFAULT_MAX_SOURCE_BYTES,
  DEFAULT_MINIMUM_EVENT_COUNT,
  EVENTS_SOURCE_URL,
  parseEventsDocument,
  readJsonResponse,
} from "./source.ts";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const CANONICAL_UTC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SAFE_RELATIVE_FILE_PATTERN = /^[a-zA-Z0-9._/-]+$/u;
const MAX_MANIFEST_SNAPSHOTS = 5_000;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_BOUNDED_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ETAG_BYTES = 1_024;

export interface HistoricalSnapshotManifestEntry {
  readonly date: string;
  readonly fetchedAt: string;
  readonly file: string;
  readonly sha256: string;
  readonly etag: string | null;
}

export interface HistoricalSnapshotManifest {
  readonly formatVersion: 1;
  readonly sourceUrl: typeof EVENTS_SOURCE_URL;
  readonly snapshots: readonly HistoricalSnapshotManifestEntry[];
}

export interface HistoricalSnapshot extends HistoricalSnapshotManifestEntry {
  readonly sourceSha256: string;
  readonly events: readonly EventRecord[];
}

export interface ReadableSnapshotFile {
  readonly read: (buffer: Uint8Array) => Promise<number | null>;
  readonly close: () => void;
}

export interface ReadHistoricalSnapshotOptions {
  readonly minimumEventCount?: number;
  readonly maximumBytes?: number;
  readonly readFile?: (path: string) => Promise<Uint8Array>;
  readonly realPath?: (path: string) => Promise<string>;
}

export class HistoricalSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoricalSnapshotError";
  }
}

export function parseHistoricalSnapshotManifest(
  input: unknown,
): HistoricalSnapshotManifest {
  const root = recordValue(input, "Snapshot manifest");
  assertExactKeys(
    root,
    ["formatVersion", "sourceUrl", "snapshots"],
    "Snapshot manifest",
  );
  if (root.formatVersion !== 1) {
    throw new HistoricalSnapshotError(
      "Snapshot manifest formatVersion must be 1",
    );
  }
  if (root.sourceUrl !== EVENTS_SOURCE_URL) {
    throw new HistoricalSnapshotError(
      `Snapshot manifest sourceUrl must be ${EVENTS_SOURCE_URL}`,
    );
  }
  if (
    !Array.isArray(root.snapshots) || root.snapshots.length < 1 ||
    root.snapshots.length > MAX_MANIFEST_SNAPSHOTS
  ) {
    throw new HistoricalSnapshotError(
      `Snapshot manifest must contain 1 through ${MAX_MANIFEST_SNAPSHOTS} snapshots`,
    );
  }

  const snapshots = root.snapshots.map(parseManifestEntry);
  for (let index = 1; index < snapshots.length; index += 1) {
    if (snapshots[index - 1]!.date >= snapshots[index]!.date) {
      throw new HistoricalSnapshotError(
        "Snapshot dates must be strictly increasing",
      );
    }
  }

  return {
    formatVersion: 1,
    sourceUrl: EVENTS_SOURCE_URL,
    snapshots,
  };
}

export async function readHistoricalSnapshot(
  manifestPath: string,
  entry: HistoricalSnapshotManifestEntry,
  options: ReadHistoricalSnapshotOptions = {},
): Promise<HistoricalSnapshot> {
  const realPath = options.realPath ?? Deno.realPath;
  const filePath = await resolveSnapshotPath(
    manifestPath,
    entry.file,
    realPath,
  );
  const maximumBytes = options.maximumBytes ?? DEFAULT_MAX_SOURCE_BYTES;
  const bytes = await (options.readFile ??
    ((path) => readBoundedFile(path, maximumBytes)))(filePath);
  if (bytes.byteLength > maximumBytes) {
    throw new HistoricalSnapshotError(
      `Snapshot ${entry.file} exceeds ${maximumBytes} bytes`,
    );
  }
  const confirmedPath = await resolveSnapshotPath(
    manifestPath,
    entry.file,
    realPath,
  );
  if (confirmedPath !== filePath) {
    throw new HistoricalSnapshotError(
      `Snapshot ${entry.file} changed paths while it was read`,
    );
  }
  const sourceSha256 = await sha256Hex(bytes);
  if (sourceSha256 !== entry.sha256) {
    throw new HistoricalSnapshotError(
      `Snapshot ${entry.file} hash does not match its manifest`,
    );
  }

  const document = await readJsonResponse(
    new Response(Uint8Array.from(bytes).buffer, {
      headers: { "content-type": "application/json" },
    }),
    maximumBytes,
  );
  const events = parseEventsDocument(document, {
    minimumEventCount: options.minimumEventCount ??
      DEFAULT_MINIMUM_EVENT_COUNT,
  });
  return { ...entry, sourceSha256, events };
}

export async function readHistoricalSnapshotManifest(
  manifestPath: string,
  readTextFile: (path: string) => Promise<string> = readBoundedManifestText,
): Promise<HistoricalSnapshotManifest> {
  let text: string;
  try {
    text = await readTextFile(manifestPath);
  } catch (error) {
    throw new HistoricalSnapshotError(
      `Could not read snapshot manifest: ${errorMessage(error)}`,
    );
  }
  if (new TextEncoder().encode(text).byteLength > MAX_MANIFEST_BYTES) {
    throw new HistoricalSnapshotError("Snapshot manifest is too large");
  }
  try {
    return parseHistoricalSnapshotManifest(JSON.parse(text));
  } catch (error) {
    if (error instanceof HistoricalSnapshotError) throw error;
    throw new HistoricalSnapshotError("Snapshot manifest is not valid JSON");
  }
}

export async function readBoundedFile(
  path: string,
  maximumBytes: number,
  openFile: (path: string) => Promise<ReadableSnapshotFile> = (path) =>
    Deno.open(path, { read: true }),
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 ||
    maximumBytes > MAX_BOUNDED_FILE_BYTES
  ) {
    throw new RangeError(
      `Maximum file size must be between 1 and ${MAX_BOUNDED_FILE_BYTES} bytes`,
    );
  }
  const file = await openFile(path);
  try {
    const buffer = new Uint8Array(maximumBytes + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const count = await file.read(buffer.subarray(offset));
      if (count === null || count === 0) break;
      offset += count;
    }
    if (offset > maximumBytes) {
      throw new HistoricalSnapshotError(
        `File ${path} exceeds ${maximumBytes} bytes`,
      );
    }
    return buffer.slice(0, offset);
  } finally {
    file.close();
  }
}

async function readBoundedManifestText(path: string): Promise<string> {
  const bytes = await readBoundedFile(path, MAX_MANIFEST_BYTES);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HistoricalSnapshotError("Snapshot manifest is not valid UTF-8");
  }
}

function parseManifestEntry(
  input: unknown,
  index: number,
): HistoricalSnapshotManifestEntry {
  const label = `Snapshot manifest entry ${index}`;
  const record = recordValue(input, label);
  assertExactKeys(
    record,
    ["date", "fetchedAt", "file", "sha256", "etag"],
    label,
  );
  if (typeof record.date !== "string") {
    throw new HistoricalSnapshotError(`${label} date must be a string`);
  }
  let date: string;
  try {
    date = parseUtcDate(record.date);
  } catch {
    throw new HistoricalSnapshotError(`${label} date is invalid`);
  }
  if (typeof record.fetchedAt !== "string") {
    throw new HistoricalSnapshotError(`${label} fetchedAt must be a string`);
  }
  const fetched = new Date(record.fetchedAt);
  if (
    !CANONICAL_UTC_TIMESTAMP_PATTERN.test(record.fetchedAt) ||
    Number.isNaN(fetched.getTime()) ||
    fetched.toISOString() !== record.fetchedAt
  ) {
    throw new HistoricalSnapshotError(`${label} fetchedAt is invalid`);
  }
  const fetchedAt = record.fetchedAt;
  if (fetchedAt.slice(0, 10) !== date) {
    throw new HistoricalSnapshotError(
      `${label} fetchedAt must fall on its UTC observation date`,
    );
  }
  if (
    typeof record.file !== "string" || record.file.length < 1 ||
    record.file.length > 1_024 ||
    !SAFE_RELATIVE_FILE_PATTERN.test(record.file) ||
    isAbsolute(record.file) ||
    record.file.split(/[\\/]/u).some((part) => part === ".." || part === "")
  ) {
    throw new HistoricalSnapshotError(
      `${label} file must be a safe relative file path`,
    );
  }
  if (
    typeof record.sha256 !== "string" || !SHA256_PATTERN.test(record.sha256)
  ) {
    throw new HistoricalSnapshotError(`${label} sha256 is invalid`);
  }
  if (
    record.etag !== null &&
    (typeof record.etag !== "string" ||
      new TextEncoder().encode(record.etag).byteLength > MAX_ETAG_BYTES)
  ) {
    throw new HistoricalSnapshotError(`${label} etag is invalid`);
  }

  return {
    date,
    fetchedAt,
    file: record.file,
    sha256: record.sha256,
    etag: record.etag,
  };
}

async function resolveSnapshotPath(
  manifestPath: string,
  file: string,
  realPath: (path: string) => Promise<string>,
): Promise<string> {
  const lexicalBase = dirname(resolve(manifestPath));
  const lexicalCandidate = resolve(lexicalBase, file);
  assertContainedPath(lexicalBase, lexicalCandidate);
  let base: string;
  let candidate: string;
  try {
    [base, candidate] = await Promise.all([
      realPath(lexicalBase),
      realPath(lexicalCandidate),
    ]);
  } catch (error) {
    throw new HistoricalSnapshotError(
      `Could not resolve snapshot file: ${errorMessage(error)}`,
    );
  }
  assertContainedPath(base, candidate);
  return candidate;
}

function assertContainedPath(base: string, candidate: string): void {
  const relativePath = relative(base, candidate);
  if (
    relativePath === ".." || relativePath.startsWith(`..${SEPARATOR}`) ||
    isAbsolute(relativePath)
  ) {
    throw new HistoricalSnapshotError(
      "Snapshot file resolves outside the manifest directory",
    );
  }
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HistoricalSnapshotError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    throw new HistoricalSnapshotError(
      `${label} contains unknown field ${unknown[0]}`,
    );
  }
  const missing = allowed.filter((key) => !(key in value));
  if (missing.length > 0) {
    throw new HistoricalSnapshotError(
      `${label} is missing field ${missing[0]}`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
