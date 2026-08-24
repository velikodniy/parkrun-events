import { parseUtcDate, utcDateOf } from "./date.ts";
import {
  type HistoricalSnapshot,
  type HistoricalSnapshotManifest,
  type HistoricalSnapshotManifestEntry,
  readHistoricalSnapshot,
  readHistoricalSnapshotManifest,
} from "./history_manifest.ts";
import {
  HistoricalSnapshotConflictError,
  HistoricalSnapshotLoader,
  type HistoricalSnapshotLoadProgress,
  type HistoricalSnapshotLoadReport,
} from "./history_loader.ts";
import { KvArchive } from "./kv_archive.ts";
import { buildRevision } from "./model.ts";

export interface HistoricalLoaderArguments {
  readonly manifestPath: string | null;
  readonly databaseUrl: string | null;
  readonly apply: boolean;
  readonly acceptPending: boolean;
  readonly help: boolean;
}

export interface HistoricalLoaderRunOptions {
  readonly today?: string;
  readonly env?: (name: string) => string | undefined;
  readonly writeLine?: (line: string) => void;
  readonly heartbeatIntervalMs?: number;
  readonly readManifest?: (
    path: string,
  ) => Promise<HistoricalSnapshotManifest>;
  readonly readSnapshot?: (
    manifestPath: string,
    entry: HistoricalSnapshotManifestEntry,
  ) => Promise<HistoricalSnapshot>;
  readonly applySnapshots?: (
    databaseUrl: string,
    entries: readonly HistoricalSnapshotManifestEntry[],
    readSnapshot: (
      entry: HistoricalSnapshotManifestEntry,
    ) => Promise<HistoricalSnapshot>,
    today: string,
    onProgress: (progress: HistoricalSnapshotLoadProgress) => void,
  ) => Promise<HistoricalSnapshotLoadReport>;
}

export function parseHistoricalLoaderArgs(
  args: readonly string[],
): HistoricalLoaderArguments {
  let manifestPath: string | null = null;
  let databaseUrl: string | null = null;
  let apply = false;
  let acceptPending = false;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--help" || argument === "-h") {
      help = true;
    } else if (argument === "--apply") {
      if (apply) throw new TypeError("Duplicate --apply argument");
      apply = true;
    } else if (argument === "--accept-pending") {
      if (acceptPending) {
        throw new TypeError("Duplicate --accept-pending argument");
      }
      acceptPending = true;
    } else if (argument === "--manifest") {
      manifestPath = uniqueOptionValue(
        "--manifest",
        manifestPath,
        args[++index],
      );
    } else if (argument.startsWith("--manifest=")) {
      manifestPath = uniqueOptionValue(
        "--manifest",
        manifestPath,
        argument.slice("--manifest=".length),
      );
    } else if (argument === "--database-url") {
      databaseUrl = uniqueOptionValue(
        "--database-url",
        databaseUrl,
        args[++index],
      );
    } else if (argument.startsWith("--database-url=")) {
      databaseUrl = uniqueOptionValue(
        "--database-url",
        databaseUrl,
        argument.slice("--database-url=".length),
      );
    } else {
      throw new TypeError(`Unknown argument ${argument}`);
    }
  }

  if (!help && manifestPath === null) {
    throw new TypeError("--manifest is required");
  }
  if (acceptPending && !apply) {
    throw new TypeError("--accept-pending requires --apply");
  }
  return { manifestPath, databaseUrl, apply, acceptPending, help };
}

export function validateProductionDatabaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidDatabaseUrl();
  }
  if (
    url.protocol !== "https:" || url.hostname !== "api.deno.com" ||
    url.port !== "" || url.username !== "" || url.password !== "" ||
    url.search !== "" || url.hash !== "" ||
    !/^\/v2\/databases\/[^/]+\/connect\/?$/u.test(url.pathname)
  ) {
    throw invalidDatabaseUrl();
  }
  return url.href.endsWith("/") ? url.href.slice(0, -1) : url.href;
}

export async function runHistoricalLoader(
  arguments_: HistoricalLoaderArguments,
  options: HistoricalLoaderRunOptions = {},
): Promise<HistoricalSnapshotLoadReport | null> {
  if (arguments_.help) {
    (options.writeLine ?? console.log)(historicalLoaderHelp());
    return null;
  }
  const manifestPath = arguments_.manifestPath!;
  const writeLine = options.writeLine ?? console.log;
  const today = parseUtcDate(options.today ?? utcDateOf(new Date()));
  const readManifest = options.readManifest ?? readHistoricalSnapshotManifest;
  const readSnapshot = options.readSnapshot ?? readHistoricalSnapshot;
  const manifest = await readManifest(manifestPath);

  for (const entry of manifest.snapshots) {
    if (entry.date > today) {
      throw new RangeError(
        `Historical snapshot ${entry.date} is in the future`,
      );
    }
    const snapshot = await readSnapshot(manifestPath, entry);
    const revision = await buildRevision(snapshot.events);
    writeLine(JSON.stringify({
      event: "snapshot_validated",
      date: entry.date,
      sourceSha256: snapshot.sourceSha256,
      revisionHash: revision.hash,
      eventCount: revision.manifest.eventCount,
    }));
  }

  if (!arguments_.apply) {
    writeLine(JSON.stringify({
      event: "snapshot_validation_finished",
      snapshotCount: manifest.snapshots.length,
    }));
    return null;
  }

  const env = options.env ?? Deno.env.get;
  if (!env("DENO_KV_ACCESS_TOKEN")) {
    throw new TypeError(
      "DENO_KV_ACCESS_TOKEN is required to write production Deno KV",
    );
  }
  const databaseUrl = validateProductionDatabaseUrl(
    arguments_.databaseUrl ?? env("DENO_KV_URL") ?? "",
  );
  const applySnapshots = options.applySnapshots ??
    applyHistoricalSnapshotsToDatabase;
  const startedAt = performance.now();
  let activeDate: string | null = null;
  writeLine(JSON.stringify({
    event: "historical_load_started",
    snapshotCount: manifest.snapshots.length,
  }));
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
  const heartbeat = heartbeatIntervalMs > 0
    ? setInterval(() => {
      writeLine(JSON.stringify({
        event: "historical_load_active",
        activeDate,
        elapsedSeconds: Math.round((performance.now() - startedAt) / 1_000),
      }));
    }, heartbeatIntervalMs)
    : null;
  let report: HistoricalSnapshotLoadReport;
  try {
    report = await applySnapshots(
      databaseUrl,
      manifest.snapshots,
      (entry) => readSnapshot(manifestPath, entry),
      today,
      (progress) => {
        activeDate = progress.phase === "SNAPSHOT_STARTED"
          ? progress.date
          : null;
        writeLine(JSON.stringify({
          event: progress.phase === "SNAPSHOT_STARTED"
            ? "snapshot_apply_started"
            : "snapshot_apply_finished",
          position: progress.index + 1,
          total: progress.total,
          date: progress.date,
          ...(progress.phase === "SNAPSHOT_FINISHED"
            ? { outcome: progress.outcome }
            : {}),
        }));
      },
    );
  } finally {
    if (heartbeat !== null) clearInterval(heartbeat);
  }
  if (report.pendingDate !== null && !arguments_.acceptPending) {
    throw new HistoricalSnapshotConflictError(
      `Snapshot ${report.pendingDate} remains safely quarantined; add a later confirming snapshot and rerun, or use --accept-pending to treat this state as successful`,
    );
  }
  writeLine(JSON.stringify({
    event: "historical_load_finished",
    snapshotCount: report.rows.length,
    pendingDate: report.pendingDate,
  }));
  return report;
}

export async function applyHistoricalSnapshotsToDatabase(
  databaseUrl: string,
  entries: readonly HistoricalSnapshotManifestEntry[],
  readSnapshot: (
    entry: HistoricalSnapshotManifestEntry,
  ) => Promise<HistoricalSnapshot>,
  today: string,
  onProgress: (progress: HistoricalSnapshotLoadProgress) => void = () => {},
  openKv: (url: string) => Promise<Deno.Kv> = Deno.openKv,
): Promise<HistoricalSnapshotLoadReport> {
  const kv = await openKv(databaseUrl);
  try {
    const loader = new HistoricalSnapshotLoader(new KvArchive(kv));
    return await loader.load(entries, readSnapshot, { today, onProgress });
  } finally {
    kv.close();
  }
}

export function historicalLoaderHelp(): string {
  return `Load dated parkrun events.json snapshots into Deno KV.

Validate only (default):
  deno task history:load --manifest <path>

Apply to production after validation succeeds:
  DENO_KV_ACCESS_TOKEN=<token> DENO_KV_URL=<connector-url> \\
    deno task history:load --manifest <path> --apply

Options:
  --manifest <path>       JSON manifest and snapshot base directory
  --database-url <url>    Production Deno KV connector URL; alternatively DENO_KV_URL
  --apply                 Write snapshots after validating every file
  --accept-pending        Treat a trailing quarantined anomaly as successful
  -h, --help              Show this help

The manifest directory must be private and remain unchanged during the run.
Tokens are accepted only through DENO_KV_ACCESS_TOKEN, never command arguments.`;
}

function uniqueOptionValue(
  name: string,
  current: string | null,
  next: string | undefined,
): string {
  if (current !== null) throw new TypeError(`Duplicate ${name} argument`);
  if (next === undefined || next.length === 0 || next.startsWith("--")) {
    throw new TypeError(`${name} requires a value`);
  }
  return next;
}

function invalidDatabaseUrl(): TypeError {
  return new TypeError(
    "Expected a production Deno KV connector URL at https://api.deno.com/v2/databases/<id>/connect",
  );
}
